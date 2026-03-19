// ─────────────────────────────────────────────────────────────────────────────
// Debate Service — Dos agentes debaten para llegar a un consenso sobre un bug
//   Ronda 1 — Agente Alfa (Debugger): identifica causa raíz y propone fix
//   Ronda 2 — Agente Beta (Arquitecto): valida o desafía la propuesta
//   Ronda 3 — Consenso: árbitro sintetiza y decide el código final
// ─────────────────────────────────────────────────────────────────────────────

import Groq from "groq-sdk";
import { GROQ_MODEL } from "./groqService";
import type { TargetLanguage } from "./geminiService";
import type { TestResult } from "./codeRunnerService";

// ─── Tipos públicos ────────────────────────────────────────────────────────────

export type DebateAgent = "debugger" | "architect" | "consensus";

export type DebateMessage = {
  id: string;
  agent: DebateAgent;
  round: number;
  content: string;
  isStreaming: boolean;
  proposedCode?: string;
};

// ─── Sistemas de personalidad de cada agente ──────────────────────────────────

const DEBUGGER_SYSTEM = `Eres el Agente Alfa, un experto en debugging y análisis de fallos de bajo nivel.
Tu misión en esta ronda:
1. Identificar la causa RAÍZ exacta del bug (no síntomas superficiales).
2. Citar la línea o estructura específica del código que falla.
3. Proponer el código corregido completo entre triple backticks con el lenguaje indicado.
4. Ser directo, técnico y preciso. Máximo 250 palabras + el bloque de código.`;

const ARCHITECT_SYSTEM = `Eres el Agente Beta, un experto en arquitectura de software y calidad de código.
Tu misión en esta ronda:
1. Revisar críticamente la solución del Agente Alfa: ¿es correcta? ¿está incompleta? ¿hay edge cases no cubiertos?
2. Si es correcta: confírmala con un argumento técnico sólido.
3. Si no es correcta o es incompleta: propón una solución alternativa o mejorada con código.
4. Mantén un debate técnico constructivo. Máximo 250 palabras + código si propones alternativa.`;

const CONSENSUS_SYSTEM = `Eres un árbitro técnico imparcial. Dos agentes han debatido un bug. Tu misión:
1. Resumir en 2 oraciones la causa raíz acordada.
2. Determinar cuál solución es la correcta (Alfa, Beta, o una síntesis de ambas).
3. Presentar el CÓDIGO FINAL corregido entre triple backticks, listo para aplicar.
4. Ser decisivo y conciso. No repetir el debate. Máximo 150 palabras + el bloque de código final.`;

// ─── Builders de prompts ──────────────────────────────────────────────────────

function buildDebuggerPrompt(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  failedTests: TestResult[]
): string {
  return `Analiza este código ${language} con tests fallidos. Encuentra el bug y propón el fix.

PSEUDOCÓDIGO ORIGINAL:
\`\`\`
${pseudocode}
\`\`\`

CÓDIGO ${language} GENERADO:
\`\`\`${language.toLowerCase()}
${code}
\`\`\`

TESTS FALLIDOS:
${failedTests
  .map(
    (t) =>
      `• "${t.description}"\n  Entrada: ${t.input || "(ninguna)"}\n  Esperado: "${t.expectedOutput}"\n  Obtenido: "${t.actualOutput}"\n  Error: ${t.error || "ninguno"}`
  )
  .join("\n\n")}

Identifica la causa raíz y presenta el código corregido completo.`;
}

function buildArchitectPrompt(
  language: TargetLanguage,
  alfaAnalysis: string,
  failedTests: TestResult[]
): string {
  return `El Agente Alfa ha propuesto la siguiente solución para el código ${language}:

=== ANÁLISIS DEL AGENTE ALFA ===
${alfaAnalysis}
=== FIN DEL ANÁLISIS ===

Tests que debían corregirse:
${failedTests.map((t) => `• "${t.description}" — Esperado: "${t.expectedOutput}"`).join("\n")}

Evalúa críticamente: ¿la causa raíz es correcta? ¿el código propuesto resuelve los tests?
¿Hay edge cases no cubiertos? Si la solución es correcta, confírmala. Si no, mejórala.`;
}

function buildConsensusPrompt(
  language: TargetLanguage,
  alfaMsg: string,
  betaMsg: string
): string {
  return `Debate sobre un bug en código ${language}:

AGENTE ALFA (Debugger):
${alfaMsg}

AGENTE BETA (Arquitecto):
${betaMsg}

Sintetiza el debate: ¿cuál es la causa raíz? ¿cuál es la solución correcta?
Presenta el código final corregido listo para usar.`;
}

// ─── Extractor de código del texto del agente ─────────────────────────────────

function extractProposedCode(text: string): string | undefined {
  const match = text.match(/```(?:[a-z+]*)\n?([\s\S]+?)```/);
  return match?.[1]?.trim();
}

// ─── Generador principal del debate ──────────────────────────────────────────

export async function* runBugDebate(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  failedTests: TestResult[],
  apiKey: string,
  model: string = GROQ_MODEL
): AsyncGenerator<DebateMessage> {
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });

  // ── Ronda 1: Agente Alfa — Debugger ──────────────────────────────────────
  let alfaContent = "";
  yield { id: "alfa-r1", agent: "debugger", round: 1, content: "", isStreaming: true };

  const alfaStream = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: DEBUGGER_SYSTEM },
      {
        role: "user",
        content: buildDebuggerPrompt(pseudocode, code, language, failedTests),
      },
    ],
    stream: true,
    temperature: 0.3,
    max_tokens: 1024,
  });

  for await (const chunk of alfaStream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      alfaContent += delta;
      yield {
        id: "alfa-r1",
        agent: "debugger",
        round: 1,
        content: alfaContent,
        isStreaming: true,
      };
    }
  }
  yield {
    id: "alfa-r1",
    agent: "debugger",
    round: 1,
    content: alfaContent,
    isStreaming: false,
    proposedCode: extractProposedCode(alfaContent),
  };

  // ── Ronda 2: Agente Beta — Arquitecto ────────────────────────────────────
  let betaContent = "";
  yield { id: "beta-r2", agent: "architect", round: 2, content: "", isStreaming: true };

  const betaStream = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: ARCHITECT_SYSTEM },
      {
        role: "user",
        content: buildArchitectPrompt(language, alfaContent, failedTests),
      },
    ],
    stream: true,
    temperature: 0.3,
    max_tokens: 1024,
  });

  for await (const chunk of betaStream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      betaContent += delta;
      yield {
        id: "beta-r2",
        agent: "architect",
        round: 2,
        content: betaContent,
        isStreaming: true,
      };
    }
  }
  yield {
    id: "beta-r2",
    agent: "architect",
    round: 2,
    content: betaContent,
    isStreaming: false,
    proposedCode: extractProposedCode(betaContent),
  };

  // ── Ronda 3: Consenso ─────────────────────────────────────────────────────
  let consensusContent = "";
  yield { id: "consensus", agent: "consensus", round: 3, content: "", isStreaming: true };

  const consensusStream = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: CONSENSUS_SYSTEM },
      {
        role: "user",
        content: buildConsensusPrompt(language, alfaContent, betaContent),
      },
    ],
    stream: true,
    temperature: 0.2,
    max_tokens: 1024,
  });

  for await (const chunk of consensusStream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      consensusContent += delta;
      yield {
        id: "consensus",
        agent: "consensus",
        round: 3,
        content: consensusContent,
        isStreaming: true,
      };
    }
  }
  yield {
    id: "consensus",
    agent: "consensus",
    round: 3,
    content: consensusContent,
    isStreaming: false,
    proposedCode: extractProposedCode(consensusContent),
  };
}
