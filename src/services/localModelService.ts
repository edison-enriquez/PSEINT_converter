export type TargetLanguage = "C" | "C++" | "Rust" | "Python";

export type ModelLoadProgress = {
  status: string;
  progress?: number;
  file?: string;
};

type WorkerMsg =
  | { type: "loaded" }
  | { type: "progress"; payload: ModelLoadProgress }
  | { type: "token"; payload: { count: number } }
  | { type: "result"; payload: string }
  | { type: "error"; payload: string };

let worker: Worker | null = null;
let modelLoaded = false;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL("../workers/modelWorker.ts", import.meta.url),
      { type: "module" }
    );
  }
  return worker;
}

export function isModelLoaded(): boolean {
  return modelLoaded;
}

export function loadLocalModel(
  onProgress?: (progress: ModelLoadProgress) => void
): Promise<void> {
  if (modelLoaded) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const w = getWorker();

    const handler = (event: MessageEvent<WorkerMsg>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        onProgress?.(msg.payload);
      } else if (msg.type === "loaded") {
        modelLoaded = true;
        w.removeEventListener("message", handler);
        resolve();
      } else if (msg.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(msg.payload));
      }
    };

    w.addEventListener("message", handler);
    w.postMessage({ type: "load" });
  });
}

const SYSTEM_PROMPT = `You are an expert programmer specializing in PSeInt pseudocode conversion to C, C++, Rust, and Python.
Your task is to convert PSeInt pseudocode into clean, idiomatic, and fully functional code in the requested target language.

## Output rules
1. Only output source code. No explanations, no markdown fences, no prose outside of code comments.
2. Add a brief Spanish comment for every logical block or translated statement.
3. Use standard libraries only.

## Language-version rules
- C: standard C11 or later.
- C++: modern C++17 or later.
- Rust: idiomatic Rust (use loop/while/for accordingly).
- Python: Python 3.x (no do-while; emulate with while True + break).

## Critical PSeInt structure mappings (MUST follow exactly)

### do-while  ← MOST COMMON MISTAKE
PSeInt:  Repetir ... Hasta Que <cond>
Meaning: execute the body AT LEAST ONCE, then keep repeating WHILE <cond> is FALSE (stop when <cond> is TRUE).
- C/C++:  do { ... } while (!(<cond>));
- Rust:   loop { ... if <cond> { break; } }
- Python: while True: ... if <cond>: break
NEVER convert Repetir...Hasta Que into a plain while loop.

### while loop
PSeInt:  Mientras <cond> Hacer ... FinMientras
- C/C++/Rust/Python: standard while loop. Condition is checked BEFORE each iteration.

### for loop
PSeInt:  Para <var> <- <inicio> Hasta <fin> Con Paso <paso> Hacer ... FinPara
- If Paso is 1 (or omitted): use a standard for/range loop.
- If Paso is negative or > 1: use the appropriate step parameter.
- C:      for (int v = inicio; v <= fin; v += paso)
- C++:    for (int v = inicio; v <= fin; v += paso)
- Rust:   for v in (inicio..=fin).step_by(paso) — handle negative steps with rev().
- Python: for v in range(inicio, fin+1, paso)

### if / if-else
PSeInt:  Si <cond> Entonces ... SiNo ... FinSi
- Standard if-else. SiNo is optional.

### switch
PSeInt:  Segun <var> Hacer  <val>: ...  De Otro Modo: ... FinSegun
- C/C++: switch with break on each case, default for De Otro Modo.
- Rust:  match expression.
- Python: match statement (>=3.10) or if/elif chain.

### Operators
- <-          assignment  (=)
- =           equality comparison  (== in C/C++/Python, == in Rust)
- <>, !=      not-equal
- Y / y       logical AND  (&& or and)
- O / o       logical OR   (|| or or)
- No / no     logical NOT  (! or not)
- DIV         integer division  (/ with int cast, // in Python, / in Rust integers)
- MOD / mod   modulo  (%, % in Rust)
- ^           exponentiation  (pow() in C/C++, f64::powi/powf in Rust, ** in Python)

### I/O
- Escribir: print/printf/println. Multiple arguments separated by commas → concatenate.
- Escribir Sin Saltar: print without newline.
- Leer: scanf / std::cin / input() / read from stdin.

### Arrays
- Dimension arreglo[N]: 0-indexed array of size N in C/C++/Rust/Python.

### Functions / Procedures
- Funcion <nombre>(<params>) ... FinFuncion  → function that returns a value.
- Proceso / SubProceso <nombre>(<params>) ... FinProceso  → void function / procedure.
`;

export async function convertPSeIntLocal(
  pseudocode: string,
  targetLanguage: TargetLanguage,
  onProgress?: (progress: ModelLoadProgress) => void,
  onToken?: (count: number) => void
): Promise<string> {
  if (!modelLoaded) {
    await loadLocalModel(onProgress);
  }

  return new Promise<string>((resolve, reject) => {
    const w = getWorker();

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Convert the following PSeInt pseudocode to ${targetLanguage}:\n\n${pseudocode}`,
      },
    ];

    const handler = (event: MessageEvent<WorkerMsg>) => {
      const msg = event.data;
      if (msg.type === "token") {
        onToken?.(msg.payload.count);
      } else if (msg.type === "result") {
        w.removeEventListener("message", handler);
        resolve(
          msg.payload
            .replace(/```[a-z]*\n?/g, "")
            .replace(/\n?```/g, "")
            .trim()
        );
      } else if (msg.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(msg.payload));
      }
    };

    w.addEventListener("message", handler);
    w.postMessage({ type: "generate", payload: { messages } });
  });
}

