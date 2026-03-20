import Groq from "groq-sdk";
import { stripThinkTags, ThinkStreamFilter } from "./modelUtils";

export type TargetLanguage = "C" | "C++" | "Rust" | "Python";

// Modelo por defecto
export const GROQ_MODEL = "llama-3.3-70b-versatile";

// Modelos disponibles en Groq
export const GROQ_MODELS: { id: string; label: string; description: string }[] = [
  { id: "llama-3.3-70b-versatile",                    label: "Llama 3.3 70B",    description: "Máxima calidad · recomendado" },
  { id: "meta-llama/llama-4-scout-17b-16e-instruct",  label: "Llama 4 Scout",    description: "Meta · multimodal y rápido" },
  { id: "qwen/qwen3-32b",                             label: "Qwen3 32B",        description: "Alibaba · razonamiento avanzado" },
  { id: "moonshotai/kimi-k2-instruct",                label: "Kimi K2",          description: "MoonshotAI · código y agentes" },
];

const SYSTEM_PROMPT = `Eres un compilador experto en PSeInt. Conviertes pseudocódigo PSeInt a código real en C, C++, Rust o Python.

## REGLA ABSOLUTA
Responde ÚNICAMENTE con código fuente. Cero explicaciones, cero texto, cero markdown fences, cero comentarios fuera del código.
El output se guardará directamente en un archivo .c/.cpp/.rs/.py y se compilará. Cualquier texto extra rompe la compilación.

## Estructura obligatoria del output
- C: incluye #include necesarios + función main() completa.
- C++: incluye #include + using namespace si aplica + main() completa.
- Rust: incluye fn main() completa y todas las dependencias estándar (use std::io, etc.).
- Python: código ejecutable sin envolturas adicionales.
NUNCA omitas el punto de entrada (main) ni los imports/headers requeridos.

## Comentarios en el código
Agrega un comentario breve en español para cada bloque lógico traducido.

## Versiones de lenguaje
- C: estándar C11 o posterior.
- C++: C++17 o posterior.
- Rust: Rust idiomático (loop/while/for según corresponda).
- Python: Python 3.x.

## Mapeo crítico de estructuras PSeInt

### do-while ← ERROR MÁS COMÚN
PSeInt:  Repetir ... Hasta Que <cond>
Significado: ejecuta el cuerpo AL MENOS UNA VEZ, continúa mientras <cond> sea FALSA (detiene cuando <cond> es VERDADERA).
- C/C++:  do { ... } while (!(<cond>));
- Rust:   loop { ... if <cond> { break; } }
- Python: while True: ... if <cond>: break
NUNCA conviertas Repetir...Hasta Que en un while normal.

### while
PSeInt:  Mientras <cond> Hacer ... FinMientras → while estándar.

### for
PSeInt:  Para <var> <- <inicio> Hasta <fin> Con Paso <paso> Hacer ... FinPara
- C/C++:  for (int v = inicio; v <= fin; v += paso)
- Rust:   for v in (inicio..=fin).step_by(paso)
- Python: for v in range(inicio, fin+1, paso)

### Operadores
- <-  asignación  (=)
- =   comparación de igualdad  (== en todos)
- <>  no igual  (!=)
- Y/O/No  AND/OR/NOT  (&&/||/! o and/or/not)
- DIV  división entera  (/ con cast en C, // en Python, / en Rust enteros)
- MOD  módulo  (%)
- ^   exponenciación  (pow() en C/C++, powi/powf en Rust, ** en Python)

### E/S
- Escribir:  print/printf/println. Múltiples argumentos separados por comas → concatenar en la misma línea.
- Escribir Sin Saltar: print sin newline final.
- Leer:  scanf / std::cin >> / input() / stdin.

### Arrays
- Dimension arreglo[N]: array de tamaño N con índice 0.

### Funciones / Procedimientos
- Funcion <nombre>(<params>) ... FinFuncion  → función que retorna valor.
- Proceso / SubProceso <nombre>(<params>) ... FinProceso  → función void.
`;

export async function convertPSeIntGroq(
  pseudocode: string,
  targetLanguage: TargetLanguage,
  apiKey: string,
  model: string = GROQ_MODEL
): Promise<string> {
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });

  try {
    const completion = await groq.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Convert the following PSeInt pseudocode to ${targetLanguage}:\n\n${pseudocode}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 2048,
    });

    const text = completion.choices[0]?.message?.content ?? "";
    if (!text) throw new Error("No response from Groq");

    return stripThinkTags(text)
      .replace(/```[a-z]*\n?/g, "")
      .replace(/\n?```/g, "")
      .trim();
  } catch (error) {
    console.error("Error converting PSeInt with Groq:", error);
    throw error;
  }
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

const EXPLAIN_SYSTEM = (pseudocode: string, code: string, lang: string) =>
  `Eres un tutor experto en programación que ayuda a estudiantes a entender cómo se convierten algoritmos de PSeInt a código real.

Pseudocódigo PSeInt del estudiante:
\`\`\`
${pseudocode}
\`\`\`

Código convertido a ${lang}:
\`\`\`${lang.toLowerCase()}
${code}
\`\`\`

Tu rol como tutor:
1. Explica en español claro y pedagógico cómo funciona el código.
2. Para cada estructura PSeInt presente (Si/Entonces, Mientras, Para, Repetir, Segun...), explica concretamente cómo se traduce a ${lang} y por qué esa es la forma correcta.
3. Responde las preguntas del estudiante de forma directa y concisa.
4. Usa bloques de código Markdown solo cuando ilustren algo concreto.
5. Evita repetir información que ya explicaste antes en la conversación.
6. Sé motivador — el objetivo es que el estudiante entienda y aprenda.`;

export async function* explainCodeGroq(
  pseudocode: string,
  convertedCode: string,
  language: TargetLanguage,
  messages: ChatMessage[],
  apiKey: string,
  model: string = GROQ_MODEL
): AsyncGenerator<string> {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });

  const stream = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: EXPLAIN_SYSTEM(pseudocode, convertedCode, language) },
      ...messages,
    ],
    stream: true,
    temperature: 0.6,
    max_tokens: 1024,
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
