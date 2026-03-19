// ─────────────────────────────────────────────────────────────────────────────
// Code Runner Service
//   • Python  → Pyodide (runs fully client-side via WASM)
//   • C / C++ → Wandbox API  (wandbox.org — free, no auth required)
//   • Rust    → Wandbox API
// ─────────────────────────────────────────────────────────────────────────────

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  compileError?: string;
};

export type TestCase = {
  id: string;
  description: string;
  input: string;
  expectedOutput: string;
};

export type TestResult = TestCase & {
  status: "pass" | "fail" | "error" | "pending" | "running";
  actualOutput: string;
  error?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Wandbox API  (https://wandbox.org)
// Free, no auth, supports GCC/Clang/Rust. POST /api/compile.json
// ─────────────────────────────────────────────────────────────────────────────

const WANDBOX_URL = "https://wandbox.org/api/compile.json";

// Compiler choices: favor latest stable GCC for C/C++, latest rustc for Rust
const WANDBOX_COMPILER: Record<string, string> = {
  C:     "gcc-head",
  "C++": "clang-head",
  Rust:  "rust-head",
};

// Extra compiler options per language
const WANDBOX_OPTIONS: Record<string, string> = {
  C:     "warning",
  "C++": "warning,c++20",
  Rust:  "",
};

export async function runWithWandbox(
  code: string,
  language: "C" | "C++" | "Rust",
  stdin = ""
): Promise<RunResult> {
  const compiler = WANDBOX_COMPILER[language];
  const options  = WANDBOX_OPTIONS[language];

  const body: Record<string, string> = {
    code,
    compiler,
    stdin,
  };
  if (options) body.options = options;

  let response: Response;
  try {
    response = await fetch(WANDBOX_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Error de red al contactar Wandbox: ${err instanceof Error ? err.message : err}`);
  }

  if (!response.ok) {
    throw new Error(`Error del servidor de ejecución Wandbox (HTTP ${response.status})`);
  }

  const data = await response.json();

  // Wandbox response fields:
  //   status          — exit code as string ("0" = ok)
  //   program_output  — stdout
  //   program_error   — stderr / runtime error
  //   compiler_error  — compilation errors

  const compileErr: string = data.compiler_error ?? "";
  const stdout: string     = data.program_output ?? "";
  const stderr: string     = data.program_error  ?? "";
  const exitCode: number   = parseInt(data.status ?? "0", 10);

  return {
    stdout,
    stderr: compileErr || stderr,
    exitCode: compileErr ? 1 : exitCode,
    compileError: compileErr || undefined,
  };
}

/** @deprecated use runWithWandbox */
export async function runWithPiston(
  code: string,
  language: "C" | "C++" | "Rust",
  stdin = ""
): Promise<RunResult> {
  return runWithWandbox(code, language, stdin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pyodide  (CPython compiled to WebAssembly via Emscripten)
// Loaded lazily from CDN on first Python run (~10 MB, cached by browser)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pyodide: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pyodidePromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPyodideFromCDN(): Promise<any> {
  // Dynamic CDN import — TypeScript doesn't know this module's types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(
    /* @vite-ignore */
    "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.mjs" as string
  );
  return mod;
}

export type PyodideProgress = { loaded: number; total: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getPyodide(onProgress?: (p: PyodideProgress) => void): Promise<any> {
  if (_pyodide) return _pyodide;
  if (_pyodidePromise) return _pyodidePromise;

  _pyodidePromise = (async () => {
    const { loadPyodide } = await loadPyodideFromCDN();

    _pyodide = await loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(onProgress ? { on_progress: (p: any) => onProgress({ loaded: p.loaded ?? 0, total: p.total ?? 0 }) } : {}),
    });

    return _pyodide;
  })();

  return _pyodidePromise;
}

export async function runPython(
  code: string,
  stdin = "",
  onProgress?: (p: PyodideProgress) => void
): Promise<RunResult> {
  const py = await getPyodide(onProgress);

  // Escape the code and stdin as JSON strings so they embed safely in Python source
  const codeJson = JSON.stringify(code);
  const stdinJson = JSON.stringify(stdin);

  // Wrapper: captures stdout/stderr, mocks stdin and input()
  const wrapper = `
import sys, builtins, traceback
from io import StringIO

_orig_stdin  = sys.stdin
_orig_stdout = sys.stdout
_orig_stderr = sys.stderr

_stdin_buf = StringIO(${stdinJson})
_out = StringIO()
_err = StringIO()

sys.stdin  = _stdin_buf
sys.stdout = _out
sys.stderr = _err
builtins.input = lambda prompt="": (
    _out.write(str(prompt)) or _stdin_buf.readline().rstrip("\\n")
)

_exit_code = 0
try:
    exec(${codeJson}, {"__name__": "__main__", "__builtins__": builtins})
except SystemExit as e:
    _exit_code = e.code if isinstance(e.code, int) else 0
except Exception:
    _err.write(traceback.format_exc())
    _exit_code = 1
finally:
    sys.stdin  = _orig_stdin
    sys.stdout = _orig_stdout
    sys.stderr = _orig_stderr

[_out.getvalue(), _err.getvalue(), _exit_code]
`;

  try {
    const proxy = py.runPython(wrapper);
    const arr = proxy.toJs();
    proxy.destroy();
    return { stdout: arr[0] ?? "", stderr: arr[1] ?? "", exitCode: arr[2] ?? 0 };
  } catch (err) {
    return { stdout: "", stderr: String(err), exitCode: 1 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export async function runCode(
  code: string,
  language: "C" | "C++" | "Rust" | "Python",
  stdin = "",
  onProgress?: (p: PyodideProgress) => void
): Promise<RunResult> {
  if (language === "Python") return runPython(code, stdin, onProgress);
  return runWithWandbox(code, language, stdin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Output comparison (HackerRank-style: normalize whitespace)
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeOutput(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function isTestPass(expected: string, actual: string): boolean {
  return normalizeOutput(expected) === normalizeOutput(actual);
}
