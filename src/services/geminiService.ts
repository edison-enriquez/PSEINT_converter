import { GoogleGenAI, GenerateContentResponse } from "@google/genai";

const envApiKey = process.env.GEMINI_API_KEY;

export type TargetLanguage = "C" | "C++" | "Rust" | "Python";

export async function convertPSeInt(
  pseudocode: string,
  targetLanguage: TargetLanguage,
  apiKey?: string
): Promise<string> {
  const key = apiKey || envApiKey;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const ai = new GoogleGenAI({ apiKey: key });
  
  const systemInstruction = `You are an expert programmer specializing in PSeInt pseudocode conversion to C, C++, Rust, and Python.
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


  const prompt = `Convert the following PSeInt pseudocode to ${targetLanguage}:\n\n${pseudocode}`;

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        systemInstruction,
        temperature: 0.2, // Low temperature for more deterministic code generation
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error("No response from AI");
    }

    // Remove markdown code blocks if present
    return text.replace(/```[a-z]*\n/g, "").replace(/\n```/g, "").trim();
  } catch (error) {
    console.error("Error converting PSeInt:", error);
    throw error;
  }
}
