import Groq from "groq-sdk";
import { stripThinkTags, ThinkStreamFilter } from "./modelUtils";

export type TargetLanguage = "C" | "C++" | "Rust" | "Python";

// Modelo por defecto
export const GROQ_MODEL = "llama-3.3-70b-versatile";

// Modelos disponibles en Groq
export const GROQ_MODELS: { id: string; label: string; description: string }[] = [
  { id: "llama-3.3-70b-versatile",   label: "Llama 3.3 70B",   description: "Máxima calidad · recomendado" },
  { id: "qwen/qwen3-32b",            label: "Qwen3 32B",        description: "Alibaba · razonamiento avanzado" },
  { id: "llama-3.1-8b-instant",      label: "Llama 3.1 8B",    description: "Más rápido · ligero" },
  { id: "gemma2-9b-it",              label: "Gemma 2 9B",      description: "Google · equilibrado" },
  { id: "mixtral-8x7b-32768",        label: "Mixtral 8×7B",    description: "Contexto 32k" },
];

const SYSTEM_PROMPT = `You are an expert programmer specializing in PSeInt pseudocode conversion to C, C++, Rust, and Python.
Your task is to convert PSeInt pseudocode into clean, idiomatic, and fully functional code in the requested target language.

## Output rules
1. Only output source code. No explanations, no markdown fences, no prose outside of code comments.
2. Add a brief Spanish comment for every logical block or translated statement.
3. Use standard libraries only.

## Language-version rules
- C: standard C11 or later.
- C++: modern C++17 or later.
- Rust: idiomatic Rust (use loop/while/for accordingly).
- Python: Python 3.x (no do-while; emulate with while True + break).

## Critical PSeInt structure mappings (MUST follow exactly)

### do-while  ← MOST COMMON MISTAKE
PSeInt:  Repetir ... Hasta Que <cond>
Meaning: execute the body AT LEAST ONCE, then keep repeating WHILE <cond> is FALSE (stop when <cond> is TRUE).
- C/C++:  do { ... } while (!(<cond>));
- Rust:   loop { ... if <cond> { break; } }
- Python: while True: ... if <cond>: break
NEVER convert Repetir...Hasta Que into a plain while loop.

### while loop
PSeInt:  Mientras <cond> Hacer ... FinMientras
- C/C++/Rust/Python: standard while loop. Condition is checked BEFORE each iteration.

### for loop
PSeInt:  Para <var> <- <inicio> Hasta <fin> Con Paso <paso> Hacer ... FinPara
- If Paso is 1 (or omitted): use a standard for/range loop.
- If Paso is negative or > 1: use the appropriate step parameter.
- C:      for (int v = inicio; v <= fin; v += paso)
- C++:    for (int v = inicio; v <= fin; v += paso)
- Rust:   for v in (inicio..=fin).step_by(paso) — handle negative steps with rev().
- Python: for v in range(inicio, fin+1, paso)

### if / if-else
PSeInt:  Si <cond> Entonces ... SiNo ... FinSi
- Standard if-else. SiNo is optional.

### switch
PSeInt:  Segun <var> Hacer  <val>: ...  De Otro Modo: ... FinSegun
- C/C++: switch with break on each case, default for De Otro Modo.
- Rust:  match expression.
- Python: match statement (>=3.10) or if/elif chain.

### Operators
- <-          assignment  (=)
- =           equality comparison  (== in C/C++/Python, == in Rust)
- <>, !=      not-equal
- Y / y       logical AND  (&& or and)
- O / o       logical OR   (|| or or)
- No / no     logical NOT  (! or not)
- DIV         integer division  (/ with int cast, // in Python, / in Rust integers)
- MOD / mod   modulo  (%, % in Rust)
- ^           exponentiation  (pow() in C/C++, f64::powi/powf in Rust, ** in Python)

### I/O
- Escribir: print/printf/println. Multiple arguments separated by commas → concatenate.
- Escribir Sin Saltar: print without newline.
- Leer: scanf / std::cin / input() / read from stdin.

### Arrays
- Dimension arreglo[N]: 0-indexed array of size N in C/C++/Rust/Python.

### Functions / Procedures
- Funcion <nombre>(<params>) ... FinFuncion  → function that returns a value.
- Proceso / SubProceso <nombre>(<params>) ... FinProceso  → void function / procedure.
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

El estudiante escribió el siguiente pseudocódigo en PSeInt:
\`\`\`
${pseudocode}
\`\`\`

Y fue convertido al siguiente código en ${lang}:
\`\`\`${lang.toLowerCase()}
${code}
\`\`\`

Tu rol:
1. Explicar en español, de forma clara y pedagógica, cómo funciona el código convertido.
2. Por cada estructura de PSeInt (Si/Entonces, Mientras, Para, Repetir...), explicar cómo se traduce al lenguaje destino y por qué.
3. Responder las preguntas del estudiante de forma concisa pero completa.
4. Usar bloques de código Markdown cuando sea útil para ilustrar.
5. Ser motivador y didáctico — el objetivo es que el estudiante aprenda.`;

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
