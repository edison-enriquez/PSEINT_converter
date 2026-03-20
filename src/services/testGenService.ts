// ─────────────────────────────────────────────────────────────────────────────
// Test Case Generation Service
// Uses the active AI (Groq or Gemini) to generate HackerRank-style test cases
// ─────────────────────────────────────────────────────────────────────────────

import Groq from "groq-sdk";
import { GoogleGenAI } from "@google/genai";
import { GROQ_MODEL } from "./groqService";
import { stripThinkTags, ThinkStreamFilter } from "./modelUtils";
import type { TargetLanguage } from "./geminiService";
import type { TestCase, TestResult } from "./codeRunnerService";

const envApiKey = process.env.GEMINI_API_KEY;

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildPrompt(pseudocode: string, code: string, lang: string): string {
  return `Genera exactamente 5 casos de prueba para este programa ${lang}.

Pseudocódigo PSeInt:
\`\`\`
${pseudocode}
\`\`\`

Código ${lang}:
\`\`\`${lang.toLowerCase()}
${code}
\`\`\`

REGLAS PARA LOS CASOS DE PRUEBA:
1. Tipo básico/normal — entrada representativa.
2. Valor mínimo o cero.
3. Valor máximo o entrada grande.
4. Valor negativo (si el algoritmo lo admite) o segundo caso normal diferente.
5. Edge case — límite, división por cero protegida, bucle con 0 iteraciones, etc.

FORMATO DE SALIDA — REGLAS CRÍTICAS:
- Responde ÚNICAMENTE con el array JSON. Sin explicaciones, sin markdown fences, sin texto fuera del JSON.
- "input": los valores que el usuario ingresaría, uno por instrucción Leer, separados por \\n. Si no hay Leer, usar "".
- "expectedOutput": TODA la salida que el programa imprime en stdout, incluyendo los mensajes de prompt (Escribir antes de Leer) y los resultados. Cada Escribir genera una línea. Usa \\n entre líneas. SIN newline final.
- SIMULA la ejecución completa: traza el programa paso a paso con los inputs dados y escribe exactamente lo que imprimiría.
- NUNCA omitas líneas de prompt. Si el pseudocódigo dice Escribir "Ingrese valor:", esa línea APARECE en expectedOutput.
- Los tests se comparan automáticamente caracter a caracter — sé preciso.

Formato requerido:
[
  {
    "id": "tc1",
    "description": "Descripción breve en español",
    "input": "valor1\\nvalor2",
    "expectedOutput": "Línea 1\\nLínea 2"
  }
]`;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseTestCases(raw: string): TestCase[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("La IA no devolvió un JSON válido con los casos de prueba");
  const cases = JSON.parse(match[0]) as TestCase[];
  return cases.map((tc, i) => ({
    id: tc.id ?? `tc${i + 1}`,
    description: tc.description ?? `Caso ${i + 1}`,
    input: tc.input ?? "",
    expectedOutput: tc.expectedOutput ?? "",
  }));
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

export async function generateTestCasesGroq(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  apiKey: string,
  model: string = GROQ_MODEL
): Promise<TestCase[]> {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });

  const completion = await groq.chat.completions.create({
    model,
    messages: [{ role: "user", content: buildPrompt(pseudocode, code, language) }],
    temperature: 0.2,
    max_tokens: 1024,
  });

  const text = stripThinkTags(completion.choices[0]?.message?.content ?? "");
  return parseTestCases(text);
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

export async function generateTestCasesGemini(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  apiKey?: string
): Promise<TestCase[]> {
  const key = apiKey || envApiKey;
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey: key });

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: buildPrompt(pseudocode, code, language),
    config: { temperature: 0.2 },
  });

  const text = response.text ?? "";
  return parseTestCases(text);
}

// ─── Fail Explanation (streaming) ────────────────────────────────────────────

function buildFailPrompt(
  code: string,
  lang: string,
  tc: TestCase,
  actualOutput: string
): string {
  return `Eres un tutor de programación. Explica por qué un test falló.

Código ${lang}:
\`\`\`${lang.toLowerCase()}
${code}
\`\`\`

Entrada usada: ${tc.input ? `\`${tc.input}\`` : "(ninguna)"}
Salida esperada: \`${tc.expectedOutput}\`
Salida obtenida: \`${actualOutput}\`

Responde en español con exactamente 3 puntos (máximo 3 oraciones en total):
1. Por qué difieren las salidas.
2. Qué línea o estructura del código lo causa.
3. Cómo corregirlo.

No repitas el código completo. No uses más de 3 oraciones. Sé directo.`;
}

export async function* explainFailedTestGroq(
  code: string,
  language: TargetLanguage,
  tc: TestCase,
  actualOutput: string,
  apiKey: string,
  model: string = GROQ_MODEL
): AsyncGenerator<string> {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });
  const stream = await groq.chat.completions.create({
    model,
    messages: [{ role: "user", content: buildFailPrompt(code, language, tc, actualOutput) }],
    stream: true,
    temperature: 0.4,
    max_tokens: 300,
  });
  const filter = new ThinkStreamFilter();
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      const visible = filter.feed(delta);
      if (visible) yield visible;
    }
  }
  const tail = filter.flush();
  if (tail) yield tail;
}

export async function* explainFailedTestGemini(
  code: string,
  language: TargetLanguage,
  tc: TestCase,
  actualOutput: string,
  apiKey?: string
): AsyncGenerator<string> {
  const key = apiKey || envApiKey;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: key });
  const responseStream = ai.models.generateContentStream({
    model: "gemini-2.0-flash",
    contents: buildFailPrompt(code, language, tc, actualOutput),
    config: { temperature: 0.4 },
  });
  for await (const chunk of await responseStream) {
    const text = chunk.text ?? "";
    if (text) yield text;
  }
}

// ─── Code Fix (one-shot) ──────────────────────────────────────────────────────

function buildFixCodePrompt(
  pseudocode: string,
  code: string,
  lang: string,
  failedTests: TestResult[]
): string {
  const testsDesc = failedTests
    .map(
      (t, i) =>
        `[Test ${i + 1}] "${t.description}"\n  Entrada: ${t.input || "(sin entrada)"}\n  Esperado:\n${t.expectedOutput}\n  Obtenido:\n${t.actualOutput || t.error || "(sin salida)"}`
    )
    .join("\n\n");

  return `Eres un experto en ${lang}. El siguiente programa falla en los casos de prueba indicados.

Pseudocódigo original (referencia de comportamiento esperado):
\`\`\`
${pseudocode}
\`\`\`

Código actual con errores:
\`\`\`${lang.toLowerCase()}
${code}
\`\`\`

Casos de prueba fallidos:
${testsDesc}

Corrige el código para que todos los tests pasen.
RESPONDE ÚNICAMENTE con el código corregido en ${lang}. Sin explicaciones, sin markdown, sin bloques de código con triple backtick. Solo el código limpio listo para ejecutar.`;
}

function stripCodeFences(raw: string): string {
  return stripThinkTags(raw)
    .replace(/^```[\w]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

export async function fixCodeWithTestsGroq(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  failedTests: TestResult[],
  apiKey: string,
  model: string = GROQ_MODEL
): Promise<string> {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });
  const completion = await groq.chat.completions.create({
    model,
    messages: [{ role: "user", content: buildFixCodePrompt(pseudocode, code, language, failedTests) }],
    temperature: 0.2,
    max_tokens: 2048,
  });
  const text = completion.choices[0]?.message?.content ?? "";
  return stripCodeFences(text);
}

export async function fixCodeWithTestsGemini(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  failedTests: TestResult[],
  apiKey?: string
): Promise<string> {
  const key = apiKey || envApiKey;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: buildFixCodePrompt(pseudocode, code, language, failedTests),
    config: { temperature: 0.2 },
  });
  const text = response.text ?? "";
  return stripCodeFences(text);
}
