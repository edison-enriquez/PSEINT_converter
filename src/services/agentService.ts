// ─────────────────────────────────────────────────────────────────────────────
// Agent Service — Bucle agentico autónomo con Vercel AI SDK
//   1. Genera tests automáticamente
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

const AGENT_SYSTEM = `Eres un agente autónomo de corrección de código. Tu ÚNICA tarea es devolver código fuente corregido.

REGLAS ABSOLUTAS:
1. Responde ÚNICAMENTE con código fuente válido — sin explicaciones, sin markdown fences, sin texto antes o después.
2. El output se guarda directamente en un archivo y se compila. Cualquier texto extra rompe la compilación.
3. Corrige TODOS los tests fallidos sin romper los tests que pasan.
4. Mantén el mismo lenguaje de programación que el código de entrada.
5. Incluye SIEMPRE todos los headers/imports necesarios y el punto de entrada (main) completo.
6. Preserva la lógica del algoritmo original; solo corrige los bugs.`;

// ─── Prompt de reparación ─────────────────────────────────────────────────────

function buildFixPrompt(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  failedResults: TestResult[]
): string {
  const failedSummary = failedResults
    .map(
      (r) =>
        `• "${r.description}"\n  Entrada: ${r.input || "(ninguna)"}\n  Esperado: "${r.expectedOutput}"\n  Obtenido: "${r.actualOutput}"\n  Error: ${r.error || "ninguno"}`
    )
    .join("\n\n");

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
  model: string = AGENT_GROQ_MODEL
): Promise<AgentResult> {
  onStep({ type: "start" });

  const groq = createGroq({ apiKey });
  let currentCode = initialCode;
  let lastResults: TestResult[] = [];
  let cachedTests: TestCase[] | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // ── Generar tests (solo primer intento) ──────────────────────────────────
    if (attempt === 1) {
      onStep({ type: "generating_tests" });
      try {
        cachedTests = await generateTestCasesGroq(pseudocode, currentCode, language, apiKey, model);
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
          prompt: buildFixPrompt(pseudocode, currentCode, language, failedResults),
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
