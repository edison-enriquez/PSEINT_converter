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
  
  const systemInstruction = `You are an expert programmer specializing in PSeInt pseudocode and target languages like C, C++, Rust, and Python.
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
