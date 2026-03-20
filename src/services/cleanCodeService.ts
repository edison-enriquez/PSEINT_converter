// ─────────────────────────────────────────────────────────────────────────────
// Clean Code Service — Genera un hilo de discusión sobre cómo mejorar el código
//   Cada ítem del hilo es un "post" con: regla, prioridad, explicación y ejemplo
// ─────────────────────────────────────────────────────────────────────────────

import Groq from "groq-sdk";
import { GROQ_MODEL } from "./groqService";
import { ThinkStreamFilter } from "./modelUtils";
import type { TargetLanguage } from "./geminiService";

// ─── Tipos públicos ────────────────────────────────────────────────────────────

export type CleanCodePriority = "critical" | "high" | "medium" | "low";
export type CleanCodeLevel = "basica" | "media" | "experta";

export type CleanCodeItem = {
  id: string;
  threadIndex: number;
  title: string;
  body: string;
  priority: CleanCodePriority;
  level: CleanCodeLevel;
  reference: string;
};

// ─── Sistema y prompt ─────────────────────────────────────────────────────────

const CLEAN_CODE_SYSTEM = `Eres un experto en Clean Code, SOLID y buenas prácticas de programación realizando un code review técnico.

REGLA ABSOLUTA DE FORMATO:
- Responde ÚNICAMENTE con el array JSON. La primera línea debe ser "[" y la última "]".
- Sin texto introductorio, sin texto final, sin markdown fences, sin explicaciones fuera del JSON.
- Si incluyes cualquier texto fuera del JSON, la respuesta será descartada.

CANTIDAD: Entre 4 y 7 ítems. Solo incluye mejoras que realmente apliquen al código dado. No inventes problemas.

CALIDAD: Cada ítem debe abordar un principio distinto y concreto. El campo "body" incluye la descripción del problema y un ejemplo "antes/después" en markdown con código real del archivo analizado.

PRINCIPIOS A REVISAR (solo los que apliquen):
- Nombres descriptivos y significativos
- Funciones pequeñas con una sola responsabilidad (SRP)
- Constantes en lugar de números mágicos
- Eliminación de comentarios redundantes o innecesarios
- Manejo de errores apropiado
- DRY — evitar código duplicado
- Legibilidad y estructura (indentación, agrupación lógica)
- Simplicidad (KISS) — no over-engineering

NIVEL DE MODIFICACIÓN — asigna "level" según cuánto esfuerzo requiere aplicar la mejora:
- "basica": Se aplica en minutos sin riesgo de romper lógica. Ej: renombrar variable, quitar comentario redundante, extraer constante.
- "media": Requiere refactoring moderado. Ej: extraer función, eliminar duplicación, reestructurar condicionales, agregar manejo de errores.
- "experta": Implica cambios arquitecturales o de diseño. Ej: aplicar un patrón de diseño, separar en módulos, reestructurar flujo completo, aplicar SOLID en profundidad.

REFERENCIAS DE LIBROS — en el campo "reference" cita el libro y capítulo más relevante para esa mejora específica:
- Usa estas referencias reales:
  * "Clean Code — R. Martin, Cap. 2: Nombres con significado"
  * "Clean Code — R. Martin, Cap. 3: Funciones"
  * "Clean Code — R. Martin, Cap. 4: Comentarios"
  * "Clean Code — R. Martin, Cap. 6: Objetos y estructuras de datos"
  * "Clean Code — R. Martin, Cap. 7: Manejo de errores"
  * "Clean Code — R. Martin, Cap. 17: Síntomas y heurísticas"
  * "The Pragmatic Programmer — Hunt & Thomas, Cap. 2: El principio DRY"
  * "Refactoring — M. Fowler, Cap. 3: Malos olores del código"
  * "Refactoring — M. Fowler: Extraer función / Renombrar variable"
  * "Code Complete — S. McConnell, Cap. 7: Rutinas de alto nivel"
  * "Code Complete — S. McConnell, Cap. 11: El poder de los nombres de variables"
  * "Clean Code — R. Martin, Principio SRP (Cap. 10)"
  * "SOLID Principles — R. Martin: Single Responsibility Principle"
- Elige la referencia más específica y precisa para cada mejora. No inventes páginas.

Formato JSON requerido:
[
  {
    "threadIndex": 1,
    "title": "Título conciso de la mejora",
    "priority": "high",
    "level": "media",
    "reference": "Clean Code — R. Martin, Cap. 3: Funciones",
    "body": "Descripción del problema.\\n\\n**Antes:**\\n\`\`\`lang\\ncódigo original\\n\`\`\`\\n\\n**Después:**\\n\`\`\`lang\\ncódigo mejorado\\n\`\`\`"
  }
]

Valores válidos para priority: "critical", "high", "medium", "low"
Valores válidos para level: "basica", "media", "experta"`;

function buildCleanCodePrompt(
  pseudocode: string,
  code: string,
  language: TargetLanguage
): string {
  return `Analiza este código ${language} generado desde pseudocódigo PSeInt y crea el hilo de Clean Code.

PSEUDOCÓDIGO ORIGINAL:
\`\`\`
${pseudocode}
\`\`\`

CÓDIGO ${language}:
\`\`\`${language.toLowerCase()}
${code}
\`\`\`

Genera el array JSON con las mejoras de Clean Code aplicables a este código específico.`;
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function generateCleanCodeThread(
  pseudocode: string,
  code: string,
  language: TargetLanguage,
  apiKey: string,
  onPartial?: (partialJson: string) => void,
  model: string = GROQ_MODEL
): Promise<CleanCodeItem[]> {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });

  let fullText = "";
  const filter = new ThinkStreamFilter();
  let visibleText = "";

  const stream = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: CLEAN_CODE_SYSTEM },
      { role: "user", content: buildCleanCodePrompt(pseudocode, code, language) },
    ],
    stream: true,
    temperature: 0.35,
    max_tokens: 2048,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      fullText += delta;
      const visible = filter.feed(delta);
      if (visible) {
        visibleText += visible;
        onPartial?.(visibleText);
      }
    }
  }
  visibleText += filter.flush();

  // Parsear JSON — buscar el array aunque venga con texto extra
  const match = fullText.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) {
    throw new Error("El modelo no devolvió un JSON válido con el hilo de Clean Code.");
  }

  const raw = JSON.parse(match[0]) as Array<{
    threadIndex?: number;
    title?: string;
    body?: string;
    priority?: string;
    level?: string;
    reference?: string;
  }>;

  const priorityMap: Record<string, CleanCodePriority> = {
    critical: "critical",
    high: "high",
    medium: "medium",
    low: "low",
  };

  const levelMap: Record<string, CleanCodeLevel> = {
    basica: "basica",
    media: "media",
    experta: "experta",
  };

  return raw.map((item, i) => ({
    id: `cc-${i + 1}`,
    threadIndex: item.threadIndex ?? i + 1,
    title: item.title ?? `Mejora ${i + 1}`,
    body: item.body ?? "",
    priority: priorityMap[item.priority ?? "medium"] ?? "medium",
    level: levelMap[item.level ?? "media"] ?? "media",
    reference: item.reference ?? "",
  }));
}
