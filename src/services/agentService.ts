// ─────────────────────────────────────────────────────────────────────────────
// Agent Service — Bucle agentico autónomo con Vercel AI SDK
//   0. (Opcional) Analiza el enunciado y extrae puntos críticos académicos
//   1. Genera tests derivados del enunciado y los puntos críticos
//   2. Ejecuta el código contra cada test
//   3. Si algún test falla: pide al LLM que corrija el código
//   4. Repite hasta MAX_ATTEMPTS o hasta que todos los tests pasen
// ─────────────────────────────────────────────────────────────────────────────

import { generateText } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { stripThinkTags } from "./modelUtils";
import type { TargetLanguage } from "./geminiService";
import { runCode, type TestCase, type TestResult, isTestPass } from "./codeRunnerService";
import { generateTestCasesGroq } from "./testGenService";

// ─── Tipos públicos ────────────────────────────────────────────────────────────

export type AgentStep =
  | { type: "start" }
  | { type: "analyzing_problem" }
  | { type: "analysis_done"; criticalPoints: string }
  | { type: "generating_tests" }
  | { type: "tests_generated"; tests: TestCase[] }
  | { type: "running_tests"; current: number; total: number }
  | { type: "tests_complete"; results: TestResult[]; passed: number; total: number }
  | { type: "fixing"; attempt: number; failCount: number }
  | { type: "code_updated"; code: string }
  | { type: "done"; code: string; results: TestResult[]; success: boolean; attempts: number }
  | { type: "error"; message: string };

export type AgentResult = {
  code: string;
  results: TestResult[];
  success: boolean;
  attempts: number;
};

// ─── Constantes ───────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;
export const AGENT_GROQ_MODEL = "llama-3.3-70b-versatile";

const AGENT_SYSTEM = `Eres un agente autónomo de corrección de código en un entorno académico. Tu ÚNICA tarea es devolver código fuente corregido que cumpla los requisitos del enunciado.

REGLAS ABSOLUTAS:
1. Responde ÚNICAMENTE con código fuente válido — sin explicaciones, sin markdown fences, sin texto antes o después.
2. El output se guarda directamente en un archivo y se compila. Cualquier texto extra rompe la compilación.
3. Cuando los tests provienen de un enunciado, el "Esperado" en cada test es el comportamiento CORRECTO según los requisitos — el código actual puede estar mal. Tu trabajo es hacer que el código cumpla el enunciado.
4. Corrige TODOS los tests fallidos sin romper los tests que pasan.
5. Mantén el mismo lenguaje de programación que el código de entrada.
6. Incluye SIEMPRE todos los headers/imports necesarios y el punto de entrada (main) completo.`;

// ─── Análisis de puntos críticos del enunciado ────────────────────────────────

const ANALYSIS_SYSTEM = `Eres un experto en testing de software académico. Tu tarea es analizar un enunciado de ejercicio de programación e identificar de forma precisa los puntos críticos que los tests DEBEN verificar.`;

async function runAnalysis(
  pseudocode: string,
  problemStatement: string,
  language: TargetLanguage,
  groq: ReturnType<typeof createGroq>,
  model: string
): Promise<string> {
  const { text } = await generateText({
    model: groq(model),
    system: ANALYSIS_SYSTEM,
    prompt: `Analiza este enunciado de ejercicio académico de programación e identifica los puntos críticos.

ENUNCIADO:
${problemStatement}

PSEUDOCÓDIGO (${language}):
${pseudocode}

Identifica:
1. PRECONDICIONES — rangos, tipos o restricciones sobre las entradas (incluye valores numéricos concretos si el enunciado los menciona).
2. POSTCONDICIONES — qué debe garantizar el programa al terminar (resultados, formato de salida, etc.).
3. CASOS LÍMITE — valores donde el comportamiento es crítico (cero, negativo, máximo permitido, cadena vacía, un solo elemento, etc.).
4. REGLAS DE NEGOCIO — condiciones especiales del enunciado (divisibilidad, paridad, comparaciones, clasificaciones, etc.). Para cada regla, describe el comportamiento esperado con un ejemplo numérico concreto.
5. INVARIANTES — propiedades que deben mantenerse (acumuladores correctos, orden, contadores, etc.).

IMPORTANTE: Si el enunciado especifica un comportamiento de error o rechazo para ciertos valores (ej. "números negativos deben dar error"), anótalo en REGLAS DE NEGOCIO con el valor exacto y el mensaje de error esperado.

Responde con una lista concisa, sin introducción ni conclusión. Máximo 200 palabras. Usa valores numéricos concretos siempre que sea posible.`,
    temperature: 0.15,
    maxOutputTokens: 500,
  });
  return stripThinkTags(text).trim();
}

// Wrapper privado para uso interno del agente (mantiene firma original)
async function analyzeProblemStatement(
  pseudocode: string,
  problemStatement: string,
  language: TargetLanguage,
  groq: ReturnType<typeof createGroq>,
  model: string
): Promise<string> {
  return runAnalysis(pseudocode, problemStatement, language, groq, model);
}

// Función pública para uso desde App.tsx en la generación standalone de tests
export async function analyzeStatementForTests(
  pseudocode: string,
  problemStatement: string,
  language: TargetLanguage,
  apiKey: string,
  model: string = AGENT_GROQ_MODEL
): Promise<string> {
  const groq = createGroq({ apiKey });
  return runAnalysis(pseudocode, problemStatement, language, groq, model);
}

// ─── Prompt de reparación ─────────────────────────────────────────────────────

function buildFixPrompt(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  failedResults: TestResult[],
  problemStatement?: string
): string {
  const failedSummary = failedResults
    .map(
      (r) =>
        `• "${r.description}"\n  Entrada: ${r.input || "(ninguna)"}\n  Esperado: "${r.expectedOutput}"\n  Obtenido: "${r.actualOutput}"\n  Error: ${r.error || "ninguno"}`
    )
    .join("\n\n");

  if (problemStatement?.trim()) {
    return `Corrige este código ${language}. Los tests FALLARON porque el código no implementa correctamente los requisitos del enunciado. El "Esperado" en cada test refleja el comportamiento correcto según el enunciado, NO lo que el código actual produce.

ENUNCIADO (fuente de verdad):
${problemStatement.trim()}

Pseudocódigo PSeInt original:
${pseudocode}

Código ${language} actual (no cumple el enunciado):
${code}

Tests fallidos (expectedOutput basado en requisitos del enunciado):
${failedSummary}

Devuelve ÚNICAMENTE el código ${language} corregido y completo (con todos los headers/imports y main) que cumpla el enunciado. Sin texto adicional.`;
  }

  return `Corrige este código ${language} generado desde pseudocódigo PSeInt. Tiene tests fallidos.

Pseudocódigo PSeInt original:
${pseudocode}

Código ${language} actual:
${code}

Tests fallidos:
${failedSummary}

Devuelve ÚNICAMENTE el código ${language} corregido y completo (con todos los headers/imports y main). Sin texto adicional.`;
}

// ─── Bucle principal ──────────────────────────────────────────────────────────

export async function runAgentLoop(
  pseudocode: string,
  initialCode: string,
  language: TargetLanguage,
  apiKey: string,
  onStep: (step: AgentStep) => void,
  model: string = AGENT_GROQ_MODEL,
  problemStatement?: string
): Promise<AgentResult> {
  onStep({ type: "start" });

  const groq = createGroq({ apiKey });
  let currentCode = initialCode;
  let lastResults: TestResult[] = [];
  let cachedTests: TestCase[] | null = null;

  // ── Fase 0: Analizar el enunciado y extraer puntos críticos ─────────────────
  let criticalPoints: string | undefined;
  if (problemStatement?.trim()) {
    onStep({ type: "analyzing_problem" });
    try {
      criticalPoints = await analyzeProblemStatement(pseudocode, problemStatement, language, groq, model);
      onStep({ type: "analysis_done", criticalPoints });
    } catch {
      // Si el análisis falla, continuar sin él — no es bloqueante
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // ── Generar tests (solo primer intento) ──────────────────────────────────
    if (attempt === 1) {
      onStep({ type: "generating_tests" });
      try {
        cachedTests = await generateTestCasesGroq(pseudocode, currentCode, language, apiKey, model, problemStatement, criticalPoints);
      } catch {
        cachedTests = [];
      }
      onStep({ type: "tests_generated", tests: cachedTests });
    }

    const tests = cachedTests ?? [];

    // ── Ejecutar tests ────────────────────────────────────────────────────────
    const results: TestResult[] = [];
    for (let i = 0; i < tests.length; i++) {
      const tc = tests[i];
      onStep({ type: "running_tests", current: i + 1, total: tests.length });
      try {
        const res = await runCode(
          currentCode,
          language,
          tc.input,
          language === "Python" ? () => {} : undefined
        );
        const actual = res.compileError
          ? `[Compile Error]\n${res.compileError}`
          : res.stdout;
        const status = res.compileError
          ? "error"
          : isTestPass(tc.expectedOutput, actual)
          ? "pass"
          : "fail";
        results.push({
          ...tc,
          status,
          actualOutput: actual,
          error: res.stderr || undefined,
        });
      } catch (err) {
        results.push({
          ...tc,
          status: "error",
          actualOutput: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    lastResults = results;
    const passed = results.filter((r) => r.status === "pass").length;
    onStep({ type: "tests_complete", results, passed, total: results.length });

    // ── ¿Todos pasaron? ───────────────────────────────────────────────────────
    if (passed === results.length) {
      onStep({ type: "done", code: currentCode, results, success: true, attempts: attempt });
      return { code: currentCode, results, success: true, attempts: attempt };
    }

    // ── Corregir código con IA ─────────────────────────────────────────────────
    if (attempt < MAX_ATTEMPTS) {
      const failedResults = results.filter((r) => r.status !== "pass");
      onStep({ type: "fixing", attempt, failCount: failedResults.length });

      try {
        const { text } = await generateText({
          model: groq(model),
          system: AGENT_SYSTEM,
          prompt: buildFixPrompt(pseudocode, currentCode, language, failedResults, problemStatement),
          temperature: 0.1,
          maxOutputTokens: 2048,
        });

        currentCode = stripThinkTags(text)
          .replace(/```[a-z]*\n?/g, "")
          .replace(/\n?```/g, "")
          .trim();
        onStep({ type: "code_updated", code: currentCode });
      } catch (err) {
        onStep({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
  }

  onStep({
    type: "done",
    code: currentCode,
    results: lastResults,
    success: false,
    attempts: MAX_ATTEMPTS,
  });
  return { code: currentCode, results: lastResults, success: false, attempts: MAX_ATTEMPTS };
}
