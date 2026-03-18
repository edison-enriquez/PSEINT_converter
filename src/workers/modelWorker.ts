import { pipeline, env } from "@huggingface/transformers";

// Solo descargar desde HuggingFace Hub
env.allowLocalModels = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPipeline = any;

let instance: AnyPipeline = null;

self.addEventListener("message", async (event: MessageEvent) => {
  const { type, payload } = event.data as {
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any;
  };

  if (type === "load") {
    if (instance) {
      self.postMessage({ type: "loaded" });
      return;
    }
    try {
      instance = await pipeline(
        "text-generation",
        "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
        {
          dtype: "q4",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          progress_callback: (p: any) => {
            self.postMessage({ type: "progress", payload: p });
          },
        }
      );
      self.postMessage({ type: "loaded" });
    } catch (err) {
      self.postMessage({
        type: "error",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (type === "generate") {
    if (!instance) {
      self.postMessage({ type: "error", payload: "El modelo no está cargado" });
      return;
    }
    try {
      const { messages } = payload as {
        messages: Array<{ role: string; content: string }>;
      };

      let tokenCount = 0;
      const output = await instance(messages, {
        max_new_tokens: 1024,
        temperature: 0.2,
        do_sample: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callback_function: (_beams: any) => {
          tokenCount++;
          self.postMessage({ type: "token", payload: { count: tokenCount } });
        },
      });

      const generated = Array.isArray(output) ? output[0] : output;
      const generatedText = generated?.generated_text;

      let text: string;
      if (Array.isArray(generatedText)) {
        const last = generatedText.at(-1) as
          | { role: string; content: string }
          | undefined;
        text = last?.content ?? "";
      } else {
        text = String(generatedText ?? "");
      }

      self.postMessage({ type: "result", payload: text });
    } catch (err) {
      self.postMessage({
        type: "error",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
