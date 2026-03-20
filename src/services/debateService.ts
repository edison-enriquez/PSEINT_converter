// ─────────────────────────────────────────────────────────────────────────────
// Debate Service — Dos agentes debaten para llegar a un consenso sobre un bug
//   Ronda 1 — Agente Alfa (Debugger): identifica causa raíz y propone fix
//   Ronda 2 — Agente Beta (Arquitecto): valida o desafía la propuesta
//   Ronda 3 — Consenso: árbitro sintetiza y decide el código final
// ─────────────────────────────────────────────────────────────────────────────

import Groq from "groq-sdk";
import { GROQ_MODEL } from "./groqService";
import { ThinkStreamFilter } from "./modelUtils";
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

const DEBUGGER_SYSTEM = `Eres el Agente Alfa, especialista en debugging y análisis de fallos.

Tu misión en esta ronda:
1. Identificar la causa RAÍZ exacta del bug (no síntomas superficiales). Una oración precisa.
2. Citar la línea o estructura específica del código que falla.
3. Proponer el código COMPLETO corregido (con todos los headers/imports y main) entre triple backticks con el lenguaje. Sin texto después del bloque de código.
4. Ser técnico y directo. Máximo 200 palabras de análisis + el bloque de código.`;

const ARCHITECT_SYSTEM = `Eres el Agente Beta, especialista en arquitectura de software y calidad de código.

Tu misión en esta ronda:
1. Evalúa si la causa raíz identificada por el Agente Alfa es correcta y suficiente.
2. Si es correcta y completa: confírmala con un argumento técnico en 2-3 oraciones.
3. Si es incorrecta o insuficiente: identifica el problema real y propón el código COMPLETO alternativo (con headers/imports y main) entre triple backticks.
4. Revisa específicamente: ¿hay edge cases no cubiertos? ¿el fix funciona para todos los tests fallidos?
5. Máximo 200 palabras de evaluación + código si propones alternativa.`;

const CONSENSUS_SYSTEM = `Eres el árbitro técnico del debate. Tu misión es producir la solución definitiva.

Estructura OBLIGATORIA de tu respuesta (en este orden):
1. **Causa raíz** (1-2 oraciones): qué provocaba el bug.
2. **Decisión** (1 oración): qué solución adoptas y por qué (Alfa, Beta o síntesis).
3. **Código final**: el código COMPLETO y compilable entre triple backticks con el lenguaje. Debe incluir todos los headers/imports y el main. Este bloque es obligatorio.

Restricciones:
- No repitas el debate ni cites fragmentos de los agentes.
- Máximo 100 palabras antes del bloque de código.
- El código final debe pasar TODOS los tests fallidos.`;

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
  let alfaVisible = "";
  const alfaFilter = new ThinkStreamFilter();
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
      const visible = alfaFilter.feed(delta);
      if (visible) {
        alfaVisible += visible;
        yield { id: "alfa-r1", agent: "debugger", round: 1, content: alfaVisible, isStreaming: true };
      }
    }
  }
  alfaVisible += alfaFilter.flush();
  yield {
    id: "alfa-r1",
    agent: "debugger",
    round: 1,
    content: alfaVisible,
    isStreaming: false,
    proposedCode: extractProposedCode(alfaContent),
  };

  // ── Ronda 2: Agente Beta — Arquitecto ────────────────────────────────────
  let betaContent = "";
  let betaVisible = "";
  const betaFilter = new ThinkStreamFilter();
  yield { id: "beta-r2", agent: "architect", round: 2, content: "", isStreaming: true };

  const betaStream = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: ARCHITECT_SYSTEM },
      {
        role: "user",
        content: buildArchitectPrompt(language, alfaVisible, failedTests),
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
      const visible = betaFilter.feed(delta);
      if (visible) {
        betaVisible += visible;
        yield { id: "beta-r2", agent: "architect", round: 2, content: betaVisible, isStreaming: true };
      }
    }
  }
  betaVisible += betaFilter.flush();
  yield {
    id: "beta-r2",
    agent: "architect",
    round: 2,
    content: betaVisible,
    isStreaming: false,
    proposedCode: extractProposedCode(betaContent),
  };

  // ── Ronda 3: Consenso ─────────────────────────────────────────────────────
  let consensusContent = "";
  let consensusVisible = "";
  const consensusFilter = new ThinkStreamFilter();
  yield { id: "consensus", agent: "consensus", round: 3, content: "", isStreaming: true };

  const consensusStream = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: CONSENSUS_SYSTEM },
      {
        role: "user",
        content: buildConsensusPrompt(language, alfaVisible, betaVisible),
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
      const visible = consensusFilter.feed(delta);
      if (visible) {
        consensusVisible += visible;
        yield { id: "consensus", agent: "consensus", round: 3, content: consensusVisible, isStreaming: true };
      }
    }
  }
  consensusVisible += consensusFilter.flush();
  yield {
    id: "consensus",
    agent: "consensus",
    round: 3,
    content: consensusVisible,
    isStreaming: false,
    proposedCode: extractProposedCode(consensusContent),
  };
}
