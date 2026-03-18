export type TargetLanguage = "C" | "C++" | "Rust" | "Python";

export type ModelLoadProgress = {
  status: string;
  progress?: number;
  file?: string;
};

type WorkerMsg =
  | { type: "loaded" }
  | { type: "progress"; payload: ModelLoadProgress }
  | { type: "token"; payload: { count: number } }
  | { type: "result"; payload: string }
  | { type: "error"; payload: string };

let worker: Worker | null = null;
let modelLoaded = false;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL("../workers/modelWorker.ts", import.meta.url),
      { type: "module" }
    );
  }
  return worker;
}

export function isModelLoaded(): boolean {
  return modelLoaded;
}

export function loadLocalModel(
  onProgress?: (progress: ModelLoadProgress) => void
): Promise<void> {
  if (modelLoaded) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const w = getWorker();

    const handler = (event: MessageEvent<WorkerMsg>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        onProgress?.(msg.payload);
      } else if (msg.type === "loaded") {
        modelLoaded = true;
        w.removeEventListener("message", handler);
        resolve();
      } else if (msg.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(msg.payload));
      }
    };

    w.addEventListener("message", handler);
    w.postMessage({ type: "load" });
  });
}

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

export async function convertPSeIntLocal(
  pseudocode: string,
  targetLanguage: TargetLanguage,
  onProgress?: (progress: ModelLoadProgress) => void,
  onToken?: (count: number) => void
): Promise<string> {
  if (!modelLoaded) {
    await loadLocalModel(onProgress);
  }

  return new Promise<string>((resolve, reject) => {
    const w = getWorker();

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Convert the following PSeInt pseudocode to ${targetLanguage}:\n\n${pseudocode}`,
      },
    ];

    const handler = (event: MessageEvent<WorkerMsg>) => {
      const msg = event.data;
      if (msg.type === "token") {
        onToken?.(msg.payload.count);
      } else if (msg.type === "result") {
        w.removeEventListener("message", handler);
        resolve(
          msg.payload
            .replace(/```[a-z]*\n?/g, "")
            .replace(/\n?```/g, "")
            .trim()
        );
      } else if (msg.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(msg.payload));
      }
    };

    w.addEventListener("message", handler);
    w.postMessage({ type: "generate", payload: { messages } });
  });
}

