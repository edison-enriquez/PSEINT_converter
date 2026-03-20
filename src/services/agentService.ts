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

const AGENT_SYSTEM = `You are an expert code debugging agent. Your ONLY task is to fix broken code.
Rules:
1. Output ONLY valid source code — no explanations, no markdown fences, no prose.
2. Fix ALL failing tests while keeping passing tests passing.
3. Stay in the same programming language as the input code.
4. Preserve the overall algorithm logic; only fix the bugs.`;

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
        `• Test "${r.description}"\n  Input: ${r.input || "(none)"}\n  Expected: ${r.expectedOutput}\n  Got: ${r.actualOutput}\n  Error: ${r.error || "none"}`
    )
    .join("\n\n");

  return `Fix this ${language} code generated from PSeInt pseudocode. It has failing tests.

Original PSeInt:
${pseudocode}

Current ${language} code:
${code}

Failing tests:
${failedSummary}

Output ONLY the corrected ${language} source code that makes all tests pass.`;
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
