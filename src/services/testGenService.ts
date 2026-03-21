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

// ─── Prompt sin enunciado — tests derivados del código (modo validación) ──────

function buildCodeBasedPrompt(pseudocode: string, code: string, lang: string): string {
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
- SIMULA la ejecución completa paso a paso y escribe exactamente lo que imprimiría.
- NUNCA omitas líneas de prompt como "Ingrese valor:".
- Los tests se comparan caracter a caracter — sé preciso.

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

// ─── Prompt con enunciado — tests derivados de REQUISITOS (modo cobertura) ────
// NO usa el código convertido para derivar expectedOutput.
// El código solo se muestra para conocer el formato exacto de I/O (mensajes Leer/Escribir).

function buildRequirementsBasedPrompt(pseudocode: string, code: string, lang: string, problemStatement: string, criticalAnalysis?: string): string {
  const testCount = criticalAnalysis?.trim() ? 8 : 7;
  const analysisSection = criticalAnalysis?.trim()
    ? `\nPuntos críticos extraídos del enunciado:\n${criticalAnalysis.trim()}\n`
    : "";

  const structureRules = criticalAnalysis?.trim()
    ? `ESTRUCTURA OBLIGATORIA — ${testCount} tests en este orden:
1-2. FLUJO NORMAL — entradas que el enunciado describe como válidas y correctas.
3-5. REGLAS DEL ENUNCIADO — un test por cada restricción o condición especial (una entrada que active cada regla, con el output que el enunciado exige).
6-7. CASOS LÍMITE — valores en los bordes de las restricciones del enunciado.
8.   CASO EXTREMO — combinación no trivial de condiciones del enunciado.`
    : `ESTRUCTURA OBLIGATORIA — ${testCount} tests en este orden:
1-2. FLUJO NORMAL — entradas válidas representativas del enunciado.
3-5. REGLAS DEL ENUNCIADO — un test por cada condición, restricción o comportamiento especial descrito explícitamente en el enunciado.
6-7. CASOS LÍMITE — valores en los bordes de las restricciones del enunciado.`;

  return `Eres un evaluador académico. Tu tarea es generar ${testCount} casos de prueba que verifiquen si un programa cumple con los REQUISITOS del enunciado.

ENUNCIADO DEL PROBLEMA (fuente de verdad para los tests):
${problemStatement.trim()}
${analysisSection}
PSEUDOCÓDIGO (solo para entender el formato de I/O: qué pide al usuario y qué imprime):
\`\`\`
${pseudocode}
\`\`\`

CÓDIGO ${lang.toUpperCase()} (referencia de formato de I/O ÚNICAMENTE — NO uses su lógica para calcular expectedOutput):
\`\`\`${lang.toLowerCase()}
${code}
\`\`\`

${structureRules}

REGLAS CRÍTICAS PARA CALCULAR expectedOutput:
1. El "expectedOutput" refleja lo que un programa CORRECTO que cumple el enunciado debe imprimir.
2. IGNORA si el código actual haría algo diferente — estás probando si el código cumple el enunciado.
3. Para cada restricción del enunciado (ej. "números negativos deben dar error"), crea un test con input que active esa restricción y expectedOutput con el mensaje de error que exige el enunciado.
4. Usa el pseudocódigo para saber qué texto de prompt imprime el programa antes de cada Leer (ej. "Ingrese número:") e inclúyelo en expectedOutput.
5. TRAZA manualmente: para cada input, simula paso a paso qué imprimiría un programa CORRECTO.
6. Si el enunciado no especifica el texto exacto del mensaje de error, usa el texto del pseudocódigo.

COBERTURA OBLIGATORIA: Cada restricción o comportamiento especial del enunciado debe tener AL MENOS un test que lo active. No omitas ninguna regla.

FORMATO DE SALIDA:
- Responde ÚNICAMENTE con el array JSON. Sin explicaciones, sin markdown fences.
- "input": valores separados por \\n, uno por instrucción Leer del pseudocódigo.
- "expectedOutput": salida completa del programa correcto, líneas separadas por \\n, SIN newline final.
- Los tests se comparan automáticamente caracter a caracter.

[
  {
    "id": "tc1",
    "description": "Descripción breve que mencione qué requisito verifica",
    "input": "valor1\\nvalor2",
    "expectedOutput": "Ingrese número:\\nResultado: 5"
  }
]`;
}

// ─── Selector de prompt ───────────────────────────────────────────────────────

function buildPrompt(pseudocode: string, code: string, lang: string, problemStatement?: string, criticalAnalysis?: string): string {
  if (problemStatement?.trim()) {
    return buildRequirementsBasedPrompt(pseudocode, code, lang, problemStatement, criticalAnalysis);
  }
  return buildCodeBasedPrompt(pseudocode, code, lang);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseTestCases(raw: string): TestCase[] {
  // Estrategia 1: encontrar el bloque [ ... ] más externo
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (!arrayMatch) throw new Error("La IA no devolvió un JSON válido con los casos de prueba");

  let parsed: unknown[];
  try {
    parsed = JSON.parse(arrayMatch[0]);
  } catch {
    // Estrategia 2: intentar reparar comillas y caracteres escapados comunes
    const repaired = arrayMatch[0]
      .replace(/[\u201C\u201D]/g, '"')   // comillas tipográficas
      .replace(/,\s*\]/g, "]")           // trailing comma
      .replace(/,\s*\}/g, "}");          // trailing comma en objeto
    try {
      parsed = JSON.parse(repaired);
    } catch {
      throw new Error("La IA no devolvió un JSON válido con los casos de prueba");
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("La IA no devolvió un JSON válido con los casos de prueba");
  }

  return (parsed as Record<string, unknown>[]).map((tc, i) => ({
    id: String(tc.id ?? `tc${i + 1}`),
    description: String(tc.description ?? `Caso ${i + 1}`),
    input: String(tc.input ?? ""),
    expectedOutput: String(tc.expectedOutput ?? ""),
  }));
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

export async function generateTestCasesGroq(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  apiKey: string,
  model: string = GROQ_MODEL,
  problemStatement?: string,
  criticalAnalysis?: string
): Promise<TestCase[]> {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });

  // Bucle agente: hasta 3 intentos. Si el JSON es inválido, el modelo recibe
  // su propia respuesta y una instrucción de corrección.
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: buildPrompt(pseudocode, code, language, problemStatement, criticalAnalysis) },
  ];

  let lastError: Error = new Error("La IA no devolvió un JSON válido con los casos de prueba");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const completion = await groq.chat.completions.create({
      model,
      messages,
      temperature: attempt === 1 ? 0.2 : 0.1,
      max_tokens: 1200,
    });

    const raw = stripThinkTags(completion.choices[0]?.message?.content ?? "");

    try {
      return parseTestCases(raw);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < 3) {
        // Añadir la respuesta errónea y la instrucción de corrección
        messages.push(
          { role: "assistant", content: raw },
          {
            role: "user",
            content:
              `Tu respuesta anterior no es un JSON válido. Devuelve ÚNICAMENTE el array JSON.` +
              ` La primera línea debe ser "[" y la última "]".` +
              ` Sin texto antes ni después. Sin markdown fences.`,
          }
        );
      }
    }
  }

  throw lastError;
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

export async function generateTestCasesGemini(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  apiKey?: string,
  problemStatement?: string,
  criticalAnalysis?: string
): Promise<TestCase[]> {
  const key = apiKey || envApiKey;
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey: key });

  let lastError: Error = new Error("La IA no devolvió un JSON válido con los casos de prueba");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = attempt === 1
      ? buildPrompt(pseudocode, code, language, problemStatement, criticalAnalysis)
      : buildPrompt(pseudocode, code, language, problemStatement, criticalAnalysis) +
        `\n\nRECUERDA: Responde ÚNICAMENTE con el array JSON. Empieza con "[" y termina con "]". Sin ningún texto adicional.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: { temperature: attempt === 1 ? 0.2 : 0.1 },
    });

    const text = response.text ?? "";
    try {
      return parseTestCases(text);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError;
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
  failedTests: TestResult[],
  problemStatement?: string
): string {
  const testsDesc = failedTests
    .map(
      (t, i) =>
        `[Test ${i + 1}] "${t.description}"\n  Entrada: ${t.input || "(sin entrada)"}\n  Esperado:\n${t.expectedOutput}\n  Obtenido:\n${t.actualOutput || t.error || "(sin salida)"}`
    )
    .join("\n\n");

  if (problemStatement?.trim()) {
    return `Eres un experto en ${lang}. El programa NO cumple con los requisitos del enunciado — los tests fallan porque el código no implementa correctamente lo que pide el enunciado.

ENUNCIADO DEL PROBLEMA (fuente de verdad — lo que el código DEBE hacer):
${problemStatement.trim()}

Pseudocódigo PSeInt (referencia de estructura I/O):
\`\`\`
${pseudocode}
\`\`\`

Código actual que NO cumple el enunciado:
\`\`\`${lang.toLowerCase()}
${code}
\`\`\`

Tests fallidos (expectedOutput derivado del enunciado, no del código):
${testsDesc}

Corrige el código para que implemente correctamente los requisitos del enunciado y pase todos los tests.
RESPONDE ÚNICAMENTE con el código corregido en ${lang}. Sin explicaciones, sin markdown, sin bloques de código con triple backtick.`;
  }

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
  model: string = GROQ_MODEL,
  problemStatement?: string
): Promise<string> {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });
  const completion = await groq.chat.completions.create({
    model,
    messages: [{ role: "user", content: buildFixCodePrompt(pseudocode, code, language, failedTests, problemStatement) }],
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
  apiKey?: string,
  problemStatement?: string
): Promise<string> {
  const key = apiKey || envApiKey;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: buildFixCodePrompt(pseudocode, code, language, failedTests, problemStatement),
    config: { temperature: 0.2 },
  });
  const text = response.text ?? "";
  return stripCodeFences(text);
}
