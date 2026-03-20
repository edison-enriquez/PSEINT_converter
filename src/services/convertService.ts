// ─────────────────────────────────────────────────────────────────────────────
// Convert Service — Conversión de PSeInt con verificación de compilación
//   1. Convierte pseudocódigo → código con LLM
//   2. Verifica compilación vía Wandbox (solo C / C++ / Rust)
//   3. Si hay error de compilación: pide al LLM que corrija (hasta 3 intentos)
// ─────────────────────────────────────────────────────────────────────────────

import Groq from "groq-sdk";
import { GROQ_MODEL, convertPSeIntGroq } from "./groqService";
import { convertPSeInt } from "./geminiService";
import { runWithWandbox } from "./codeRunnerService";
import { stripThinkTags } from "./modelUtils";
import type { TargetLanguage } from "./geminiService";

// ─── Tipos públicos ────────────────────────────────────────────────────────────

export type ConvertStep =
  | { type: "converting" }
  | { type: "verifying"; code: string }
  | { type: "fixing_compile"; attempt: number; error: string; code: string }
  | { type: "done"; code: string; verified: boolean; fixed: boolean }
  | { type: "error"; message: string };

// ─── Constantes ───────────────────────────────────────────────────────────────

const MAX_FIX_ATTEMPTS = 3;

// ─── Prompt de corrección de errores de compilación ──────────────────────────

function buildCompileFixPrompt(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  compileError: string
): string {
  return `Este código ${language} tiene errores de compilación. Corrígelos.

Pseudocódigo PSeInt original (define el comportamiento esperado):
\`\`\`
${pseudocode}
\`\`\`

Código ${language} con errores:
\`\`\`${language.toLowerCase()}
${code}
\`\`\`

Error del compilador:
\`\`\`
${compileError.slice(0, 1000)}
\`\`\`

REGLA ABSOLUTA: Devuelve ÚNICAMENTE el código ${language} corregido y completo (con todos los headers/imports y main). Sin texto adicional, sin markdown fences.`;
}

// ─── Generador principal ──────────────────────────────────────────────────────

export async function* convertAndVerify(
  pseudocode: string,
  language: TargetLanguage,
  groqModel: string = GROQ_MODEL,
  groqApiKey: string,
  geminiApiKey?: string,
  useGemini = false
): AsyncGenerator<ConvertStep> {
  // ── Paso 1: Conversión LLM ─────────────────────────────────────────────────
  yield { type: "converting" };

  let code: string;
  try {
    code = useGemini
      ? await convertPSeInt(pseudocode, language, geminiApiKey)
      : await convertPSeIntGroq(pseudocode, language, groqApiKey, groqModel);
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  // ── Paso 2: Verificación de compilación ────────────────────────────────────
  // Python usa Pyodide (WASM ~10 MB); omitimos verificación automática
  if (language === "Python") {
    yield { type: "done", code, verified: false, fixed: false };
    return;
  }

  yield { type: "verifying", code };

  let compileError: string | null = null;
  try {
    const result = await runWithWandbox(code, language as "C" | "C++" | "Rust", "");
    compileError = result.compileError || null;
  } catch {
    // Wandbox inalcanzable — devolver código sin verificar
    yield { type: "done", code, verified: false, fixed: false };
    return;
  }

  if (!compileError) {
    yield { type: "done", code, verified: true, fixed: false };
    return;
  }

  // ── Paso 3: Bucle de corrección de errores de compilación ─────────────────
  if (!groqApiKey) {
    // Sin API key de Groq no podemos corregir (Gemini no tiene este loop)
    yield { type: "done", code, verified: false, fixed: false };
    return;
  }

  const groq = new Groq({ apiKey: groqApiKey, dangerouslyAllowBrowser: true });
  let currentCode = code;
  let currentError = compileError;

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    yield { type: "fixing_compile", attempt, error: currentError, code: currentCode };

    // Pedir al LLM que corrija el error de compilación
    let fixedCode: string;
    try {
      const completion = await groq.chat.completions.create({
        model: groqModel,
        messages: [
          { role: "user", content: buildCompileFixPrompt(pseudocode, currentCode, language, currentError) },
        ],
        temperature: 0.1,
        max_tokens: 2048,
      });
      fixedCode = stripThinkTags(completion.choices[0]?.message?.content ?? "")
        .replace(/```[a-z+]*\n?/g, "")
        .replace(/\n?```/g, "")
        .trim();
    } catch {
      // Error de API — devolver el mejor código hasta ahora
      yield { type: "done", code: currentCode, verified: false, fixed: attempt > 1 };
      return;
    }

    currentCode = fixedCode;

    // Verificar si el fix compiló
    yield { type: "verifying", code: currentCode };
    try {
      const result = await runWithWandbox(currentCode, language as "C" | "C++" | "Rust", "");
      if (!result.compileError) {
        yield { type: "done", code: currentCode, verified: true, fixed: true };
        return;
      }
      currentError = result.compileError;
    } catch {
      yield { type: "done", code: currentCode, verified: false, fixed: true };
      return;
    }
  }

  // Intentos agotados — devolver mejor código disponible
  yield { type: "done", code: currentCode, verified: false, fixed: true };
}
