import Groq from "groq-sdk";

export type TargetLanguage = "C" | "C++" | "Rust" | "Python";

// Modelo rápido y gratuito de Groq con excelente capacidad de código
export const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are an expert programmer specializing in PSeInt pseudocode and target languages like C, C++, Rust, and Python.
Your task is to convert PSeInt pseudocode into clean, idiomatic, and functional code in the requested target language.
Follow these rules:
1. Only provide the code. Do not include explanations unless they are comments within the code.
2. Use standard libraries for the target language.
3. Ensure the logic of the original pseudocode is preserved exactly.
4. If the pseudocode is invalid or incomplete, try to fix common errors but prioritize accuracy.
5. For C, use standard C (C11 or later).
6. For C++, use modern C++ (C++17 or later).
7. For Rust, follow idiomatic Rust patterns.
8. For Python, use Python 3.x syntax.
9. Add a comment for each line translated from the original pseudocode to explain its purpose, use comments in Spanish.`;

export async function convertPSeIntGroq(
  pseudocode: string,
  targetLanguage: TargetLanguage,
  apiKey: string
): Promise<string> {
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true });

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
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

    return text.replace(/```[a-z]*\n?/g, "").replace(/\n?```/g, "").trim();
  } catch (error) {
    console.error("Error converting PSeInt with Groq:", error);
    throw error;
  }
}
