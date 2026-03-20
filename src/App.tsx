import { useState, useEffect, useRef } from "react";
import { convertPSeInt, TargetLanguage, explainCodeGemini } from "./services/geminiService";
import { convertPSeIntGroq, GROQ_MODEL, GROQ_MODELS, explainCodeGroq, ChatMessage } from "./services/groqService";
import { runCode, TestCase, TestResult, isTestPass, PyodideProgress } from "./services/codeRunnerService";
import { generateTestCasesGroq, generateTestCasesGemini, explainFailedTestGroq, explainFailedTestGemini, fixCodeWithTestsGroq, fixCodeWithTestsGemini } from "./services/testGenService";
import { Code2, Copy, Check, Terminal, Languages, RefreshCw, AlertCircle, Sparkles, KeyRound, Eye, EyeOff, Zap, Settings, X, MessageCircle, Send, Bot, User, Play, FlaskConical, CheckCircle2, XCircle, ChevronDown, ChevronRight, Loader, BrainCircuit, Swords, Wand2, ShieldCheck, Scale, Wrench } from "lucide-react";
import { DiffEditor } from "@monaco-editor/react";
import { runAgentLoop, type AgentStep, type AgentResult } from "./services/agentService";
import { runBugDebate, type DebateMessage } from "./services/debateService";
import { generateCleanCodeThread, type CleanCodeItem } from "./services/cleanCodeService";
import { convertAndVerify, type ConvertStep } from "./services/convertService";
import * as Prism from "prismjs";
import Editor from "react-simple-code-editor";
import "prismjs/themes/prism-tomorrow.css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-python";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import ReactMarkdown from "react-markdown";

// Define PSeInt language for Prism
Prism.languages.pseint = {
  'comment': [
    {
      pattern: /\/\/.*|(?:\/\*[\s\S]*?\*\/)/,
      greedy: true
    }
  ],
  'string': {
    pattern: /(["'])(?:(?!\1)[^\\\r\n]|\\.)*\1/,
    greedy: true
  },
  'keyword': /\b(?:Algoritmo|FinAlgoritmo|Definir|Como|Entero|Real|Logico|Cadena|Escribir|Leer|Si|Entonces|SiNo|FinSi|Segun|Hacer|FinSegun|Mientras|FinMientras|Repetir|Hasta Que|Para|FinPara|Funcion|FinFuncion|Dimension|Proceso|FinProceso)\b/i,
  'boolean': /\b(?:Verdadero|Falso)\b/i,
  'operator': /<-|<=|>=|<>|[-+*/^=<>]/,
  'number': /\b\d+(?:\.\d+)?\b/,
  'punctuation': /[()[\],.;]/
};

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── Monaco diff helper ────────────────────────────────────────────────────────
function toMonacoLang(lang: string): string {
  if (lang === "C++") return "cpp";
  if (lang === "C") return "c";
  return lang.toLowerCase(); // python, rust
}

function CodeDiffView({
  oldCode,
  newCode,
  monacoLang = "python",
}: {
  oldCode: string;
  newCode: string;
  monacoLang?: string;
}) {
  return (
    <DiffEditor
      height="260px"
      language={monacoLang}
      original={oldCode}
      modified={newCode}
      theme="vs-dark"
      options={{
        renderSideBySide: false,
        readOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        lineNumbers: "on",
        folding: false,
        glyphMargin: true,
        lineDecorationsWidth: 6,
        renderLineHighlight: "none",
        scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      }}
      loading={
        <div className="flex items-center justify-center h-16 text-xs text-slate-400 bg-[#1e1e1e]">
          <Loader className="w-3.5 h-3.5 animate-spin mr-2" /> Cargando editor…
        </div>
      }
    />
  );
}

const markdownComponents = {
  pre: ({ children }: React.ComponentPropsWithoutRef<"pre">) => (
    <pre className="bg-black/40 rounded-lg p-3 overflow-x-auto my-2 border border-white/5 text-[11px] font-mono text-slate-200 leading-relaxed">{children}</pre>
  ),
  code: ({ className, children }: React.ComponentPropsWithoutRef<"code">) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="bg-black/30 rounded px-1 py-0.5 font-mono text-[11px] text-indigo-300">{children}</code>
    ),
  p: ({ children }: React.ComponentPropsWithoutRef<"p">) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }: React.ComponentPropsWithoutRef<"strong">) => <strong className="text-white font-semibold">{children}</strong>,
  ul: ({ children }: React.ComponentPropsWithoutRef<"ul">) => <ul className="list-disc list-inside mb-2 space-y-0.5 text-slate-300">{children}</ul>,
  ol: ({ children }: React.ComponentPropsWithoutRef<"ol">) => <ol className="list-decimal list-inside mb-2 space-y-0.5 text-slate-300">{children}</ol>,
  li: ({ children }: React.ComponentPropsWithoutRef<"li">) => <li>{children}</li>,
  h3: ({ children }: React.ComponentPropsWithoutRef<"h3">) => <h3 className="font-semibold text-slate-100 mb-1 mt-3 text-xs">{children}</h3>,
  h2: ({ children }: React.ComponentPropsWithoutRef<"h2">) => <h2 className="font-semibold text-slate-100 mb-1 mt-3 text-xs">{children}</h2>,
};

const EXAMPLE_PSEINT = `Algoritmo SumaDeDosNumeros
    Definir num1, num2, resultado Como Entero
    Escribir "Ingrese el primer número:"
    Leer num1
    Escribir "Ingrese el segundo número:"
    Leer num2
    resultado <- num1 + num2
    Escribir "La suma es: ", resultado
FinAlgoritmo`;

type ModelType = "gemini" | "groq";

type EnabledModels = { gemini: boolean; agents: boolean; suggestFix: boolean };

function loadEnabledModels(): EnabledModels {
  try {
    const raw = localStorage.getItem("enabled_models");
    if (raw) {
      const parsed = JSON.parse(raw) as EnabledModels;
      // Garantizar que suggestFix exista (clave nueva) sin borrar el resto
      return { suggestFix: false, ...parsed };
    }
  } catch { /* ignore */ }
  // Por defecto solo Groq activo; Gemini, Agentes y Sugerir corrección desactivados
  return { gemini: false, agents: false, suggestFix: false };
}

export default function App() {
  const [input, setInput] = useState(EXAMPLE_PSEINT);
  const [output, setOutput] = useState("");
  const [language, setLanguage] = useState<TargetLanguage>("C");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelType>("groq");
  const [geminiApiKey, setGeminiApiKey] = useState<string>(
    () => localStorage.getItem("gemini_api_key") ?? process.env.GEMINI_API_KEY ?? ""
  );
  const [groqApiKey, setGroqApiKey] = useState<string>(
    () => localStorage.getItem("groq_api_key") ?? ""
  );
  const [groqModel, setGroqModelState] = useState<string>(
    () => localStorage.getItem("groq_model") ?? GROQ_MODEL
  );
  const setGroqModel = (m: string) => {
    setGroqModelState(m);
    localStorage.setItem("groq_model", m);
  };
  const [showApiKey, setShowApiKey] = useState(false);
  const [enabledModels, setEnabledModels] = useState<EnabledModels>(loadEnabledModels);
  const [showSettings, setShowSettings] = useState(false);
  const [inferenceElapsed, setInferenceElapsed] = useState(0);
  const inferenceStartRef = useRef<number | null>(null);
  const inferenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // — Explainer chat state —
  const [showExplainer, setShowExplainer] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // — Code Runner state —
  const [showRunner, setShowRunner] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [runResult, setRunResult] = useState<{ stdout: string; stderr: string; exitCode: number; compileError?: string } | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [pyodideProgress, setPyodideProgress] = useState<PyodideProgress | null>(null);

  // — Test Cases state —
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [testRunning, setTestRunning] = useState(false);
  const [generatingTests, setGeneratingTests] = useState(false);
  const [expandedTests, setExpandedTests] = useState<Set<string>>(new Set());
  const [testExplanations, setTestExplanations] = useState<Record<string, string>>({});
  const [streamingExplanations, setStreamingExplanations] = useState<Record<string, string>>({});

  // — Agent state —
  const [showAgent, setShowAgent] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);

  // — Debate state —
  const [showDebate, setShowDebate] = useState(false);
  const [debateRunning, setDebateRunning] = useState(false);
  const [debateMessages, setDebateMessages] = useState<DebateMessage[]>([]);

  // — Clean Code state —
  const [showCleanCode, setShowCleanCode] = useState(false);
  const [cleanCodeLoading, setCleanCodeLoading] = useState(false);
  const [cleanCodeItems, setCleanCodeItems] = useState<CleanCodeItem[]>([]);
  const [cleanCodePartial, setCleanCodePartial] = useState("");
  const [expandedCleanCode, setExpandedCleanCode] = useState<Set<string>>(new Set("cc-1"));

  // — Sugerencia de corrección por prueba —
  const [testSuggestions, setTestSuggestions] = useState<Record<string, string>>({});
  const [testSuggestionLoading, setTestSuggestionLoading] = useState<Record<string, boolean>>({});

  // — Estado de verificación de conversión —
  const [lastConvertStep, setLastConvertStep] = useState<ConvertStep | null>(null);;

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, streamingMessage]);

  const toggleModel = (model: keyof EnabledModels) => {
    setEnabledModels((prev) => {
      const next = { ...prev, [model]: !prev[model] };
      localStorage.setItem("enabled_models", JSON.stringify(next));
      // Si se deshabilita el modelo activo, cambiar a groq
      if (!next[model as ModelType] && selectedModel === model) {
        setSelectedModel("groq");
      }
      return next;
    });
  };

  const handleConvert = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    setLastConvertStep(null);
    setInferenceElapsed(0);

    // Arrancar el timer global desde el inicio
    inferenceStartRef.current = performance.now();
    inferenceTimerRef.current = setInterval(() => {
      if (inferenceStartRef.current) {
        setInferenceElapsed(
          (performance.now() - inferenceStartRef.current) / 1000
        );
      }
    }, 200);

    try {
      let stateReset = false;
      for await (const step of convertAndVerify(
        input, language, groqModel, groqApiKey,
        geminiApiKey || undefined,
        selectedModel === "gemini"
      )) {
        setLastConvertStep(step);

        if (step.type === "error") {
          const message = step.message;
          if (message.includes("GEMINI_API_KEY") || message.includes("GROQ_API_KEY")) {
            setError("Falta la clave de API. Ingrésala en el campo correspondiente.");
          } else if (message.includes("API key") || message.includes("401") || message.includes("403") || message.includes("invalid_api_key")) {
            setError("Clave de API inválida o sin permisos. Verifica tu clave.");
          } else if (message.includes("404") || message.includes("not found")) {
            setError(`Modelo no encontrado: ${message}`);
          } else if (message.includes("fetch") || message.includes("network") || message.includes("Failed to fetch")) {
            setError("Error de red. Comprueba tu conexión a internet.");
          } else {
            setError(`Error: ${message}`);
          }
          console.error(step.message);
          return;
        }

        // Mostrar el código en cuanto está disponible y resetear estado dependiente
        if ("code" in step && step.code) {
          setOutput(step.code);
          if (!stateReset) {
            stateReset = true;
            // Reset chat so the explainer shows context for the new conversion
            setChatMessages([]);
            setShowExplainer(false);
            setStreamingMessage("");
            // Reset runner
            setRunResult(null);
            setTestCases([]);
            setTestResults([]);
            setRunInput("");
            setTestExplanations({});
            setStreamingExplanations({});
            // Reset agent / debate / clean code / fix
            setAgentSteps([]);
            setAgentResult(null);
            setShowAgent(false);
            setDebateMessages([]);
            setShowDebate(false);
            setCleanCodeItems([]);
            setCleanCodePartial("");
            setShowCleanCode(false);
            setTestSuggestions({});
            setTestSuggestionLoading({});
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("GEMINI_API_KEY") || message.includes("GROQ_API_KEY")) {
        setError("Falta la clave de API. Ingrésala en el campo correspondiente.");
      } else if (message.includes("API key") || message.includes("401") || message.includes("403") || message.includes("invalid_api_key")) {
        setError("Clave de API inválida o sin permisos. Verifica tu clave.");
      } else if (message.includes("404") || message.includes("not found")) {
        setError(`Modelo no encontrado: ${message}`);
      } else if (message.includes("fetch") || message.includes("network") || message.includes("Failed to fetch")) {
        setError("Error de red. Comprueba tu conexión a internet.");
      } else {
        setError(`Error: ${message}`);
      }
      console.error(err);
    } finally {
      setLoading(false);
      // Detener y limpiar el timer
      if (inferenceTimerRef.current) {
        clearInterval(inferenceTimerRef.current);
        inferenceTimerRef.current = null;
      }
      inferenceStartRef.current = null;
    }
  };

  const sendExplainMessage = async (userMessage: string) => {
    if (!output) return;
    const newMessages: ChatMessage[] = [
      ...chatMessages,
      { role: "user", content: userMessage },
    ];
    setChatMessages(newMessages);
    setChatInput("");
    setChatLoading(true);
    setStreamingMessage("");
    try {
      let full = "";
      const generator =
        selectedModel === "gemini"
          ? explainCodeGemini(input, output, language, newMessages, geminiApiKey || undefined)
          : explainCodeGroq(input, output, language, newMessages, groqApiKey, groqModel);
      for await (const chunk of generator) {
        full += chunk;
        setStreamingMessage(full);
      }
      setChatMessages((prev) => [...prev, { role: "assistant", content: full }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = msg.includes("API_KEY")
        ? `Verifica tu clave de API de ${selectedModel === "gemini" ? "Gemini" : "Groq"}.`
        : msg;
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ ${friendly}` },
      ]);
    } finally {
      setChatLoading(false);
      setStreamingMessage("");
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;
    await sendExplainMessage(chatInput);
  };

  // ── Code Runner ───────────────────────────────────────────────────────────

  const handleRun = async (stdinOverride?: string) => {
    if (!output) return;
    setRunLoading(true);
    setRunResult(null);
    setPyodideProgress(null);
    try {
      const result = await runCode(
        output,
        language,
        stdinOverride ?? runInput,
        language === "Python" ? (p) => setPyodideProgress(p) : undefined
      );
      setRunResult(result);
    } catch (err) {
      setRunResult({ stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 });
    } finally {
      setRunLoading(false);
      setPyodideProgress(null);
    }
  };

  const handleGenerateTests = async () => {
    if (!output) return;
    setGeneratingTests(true);
    setTestCases([]);
    setTestResults([]);
    try {
      const cases =
        selectedModel === "gemini"
          ? await generateTestCasesGemini(input, output, language, geminiApiKey || undefined)
          : await generateTestCasesGroq(input, output, language, groqApiKey, groqModel);
      setTestCases(cases);
      setTestResults(cases.map((tc) => ({ ...tc, status: "pending", actualOutput: "" })));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Error al generar tests: ${msg}`);
    } finally {
      setGeneratingTests(false);
    }
  };

  const handleRunAllTests = async () => {
    if (!output || testCases.length === 0) return;
    setTestRunning(true);
    setTestSuggestions({}); // reset suggestions when re-running tests
    setTestSuggestionLoading({});

    // Mark all as running
    setTestResults(testCases.map((tc) => ({ ...tc, status: "running", actualOutput: "" })));

    const results: TestResult[] = [];
    for (const tc of testCases) {
      // Update current as running
      setTestResults((prev) =>
        prev.map((r) => (r.id === tc.id ? { ...r, status: "running" } : r))
      );
      try {
        const res = await runCode(output, language, tc.input,
          language === "Python" ? () => {} : undefined
        );
        const actual = res.compileError
          ? `[Error de compilación]\n${res.compileError}`
          : res.stdout;
        const status = res.compileError
          ? "error"
          : isTestPass(tc.expectedOutput, actual)
          ? "pass"
          : "fail";
        results.push({ ...tc, status, actualOutput: actual, error: res.stderr || undefined });
      } catch (err) {
        results.push({
          ...tc,
          status: "error",
          actualOutput: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const snap = [...results];
      const pending = testCases.slice(snap.length).map((t) => ({ ...t, status: "pending" as const, actualOutput: "" }));
      setTestResults([...snap, ...pending]);
    }

    setTestResults(results);
    setTestRunning(false);

    // Auto-generate explanations for failed tests (fire and forget, streaming)
    const failed = results.filter((r) => r.status === "fail");
    if (failed.length === 0) return;

    // Expand failed tests automatically
    setExpandedTests((prev) => {
      const next = new Set(prev);
      failed.forEach((r) => next.add(r.id));
      return next;
    });

    for (const r of failed) {
      setStreamingExplanations((prev) => ({ ...prev, [r.id]: "" }));
      try {
        const generator =
          selectedModel === "gemini"
            ? explainFailedTestGemini(output, language, r, r.actualOutput, geminiApiKey || undefined)
            : explainFailedTestGroq(output, language, r, r.actualOutput, groqApiKey, groqModel);
        let full = "";
        for await (const chunk of generator) {
          full += chunk;
          setStreamingExplanations((prev) => ({ ...prev, [r.id]: full }));
        }
        setTestExplanations((prev) => ({ ...prev, [r.id]: full }));
      } catch {
        setTestExplanations((prev) => ({ ...prev, [r.id]: "No se pudo generar la explicación." }));
      } finally {
        setStreamingExplanations((prev) => {
          const next = { ...prev };
          delete next[r.id];
          return next;
        });
      }
    }
  };

  const toggleTestExpand = (id: string) => {
    setExpandedTests((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Sugerir corrección por prueba individual ────────────────────────────

  const handleSuggestFix = async (testId: string) => {
    const tr = testResults.find((r) => r.id === testId);
    if (!tr || !output || !groqApiKey) return;
    setTestSuggestionLoading((prev) => ({ ...prev, [testId]: true }));
    setTestSuggestions((prev) => { const next = { ...prev }; delete next[testId]; return next; });
    try {
      const fixed =
        selectedModel === "gemini"
          ? await fixCodeWithTestsGemini(input, output, language, [tr], geminiApiKey || undefined)
          : await fixCodeWithTestsGroq(input, output, language, [tr], groqApiKey, groqModel);
      setTestSuggestions((prev) => ({ ...prev, [testId]: fixed }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Error al sugerir corrección: ${msg}`);
    } finally {
      setTestSuggestionLoading((prev) => ({ ...prev, [testId]: false }));
    }
  };

  // ── Agent loop ────────────────────────────────────────────────────────────

  const handleRunAgent = async () => {
    if (!output || !groqApiKey) return;
    setShowAgent(true);
    setShowDebate(false);
    setShowCleanCode(false);
    setShowExplainer(false);
    setShowRunner(false);
    setAgentRunning(true);
    setAgentSteps([]);
    setAgentResult(null);

    const result = await runAgentLoop(
      input,
      output,
      language,
      groqApiKey,
      (step) => setAgentSteps((prev) => {
        // Update the last step of same type, or append new
        const updated = [...prev];
        let lastIdx = -1;
        for (let k = updated.length - 1; k >= 0; k--) {
          if (updated[k].type === step.type) { lastIdx = k; break; }
        }
        if (
          lastIdx !== -1 &&
          (step.type === "running_tests" || step.type === "fixing" || step.type === "code_updated")
        ) {
          updated[lastIdx] = step;
        } else {
          updated.push(step);
        }
        return updated;
      }),
      groqModel
    );

    setAgentResult(result);
    setAgentRunning(false);

    // Si el agente encontró una versión corregida con éxito, aplicar al editor
    if (result.success && result.code !== output) {
      setOutput(result.code);
      setTestResults(result.results);
      setTestCases(result.results.map(({ id, description, input: inp, expectedOutput }) => ({
        id, description, input: inp, expectedOutput,
      })));
    }
  };

  // ── Debate de bugs ────────────────────────────────────────────────────────

  const handleStartDebate = async (failedTests: TestResult[]) => {
    if (!output || !groqApiKey || failedTests.length === 0) return;
    setShowDebate(true);
    setShowAgent(false);
    setShowCleanCode(false);
    setShowExplainer(false);
    setShowRunner(false);
    setDebateRunning(true);
    setDebateMessages([]);

    try {
      for await (const msg of runBugDebate(input, output, language, failedTests, groqApiKey, groqModel)) {
        setDebateMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === msg.id);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = msg;
            return next;
          }
          return [...prev, msg];
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setDebateMessages((prev) => [
        ...prev,
        { id: "error", agent: "consensus", round: 0, content: `⚠️ Error: ${errMsg}`, isStreaming: false },
      ]);
    } finally {
      setDebateRunning(false);
    }
  };

  // ── Hilo de Código Limpio ──────────────────────────────────────────────────

  const handleGenerateCleanCode = async () => {
    if (!output || !groqApiKey) return;
    setShowCleanCode(true);
    setShowDebate(false);
    setShowAgent(false);
    setShowExplainer(false);
    setShowRunner(false);
    setCleanCodeLoading(true);
    setCleanCodeItems([]);
    setCleanCodePartial("");

    try {
      const items = await generateCleanCodeThread(
        input,
        output,
        language,
        groqApiKey,
        (partial) => setCleanCodePartial(partial),
        groqModel
      );
      setCleanCodeItems(items);
      setExpandedCleanCode(new Set(items.slice(0, 2).map((i) => i.id)));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setCleanCodeItems([{
        id: "error",
        threadIndex: 1,
        title: "Error al generar hilo",
        body: `No se pudo generar el análisis: ${errMsg}`,
        priority: "low",
        level: "basica",
        reference: "",
      }]);
    } finally {
      setCleanCodeLoading(false);
      setCleanCodePartial("");
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getPrismLanguage = (lang: TargetLanguage) => {
    switch (lang) {
      case "C": return "c";
      case "C++": return "cpp";
      case "Rust": return "rust";
      case "Python": return "python";
      default: return "clike";
    }
  };

  return (
    <div className="min-h-screen bg-[#0f1117] text-slate-200 font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-[#161b22]/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 sm:h-16 flex flex-col sm:flex-row items-center justify-between gap-4 sm:gap-0">
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/20 shrink-0">
              <Code2 className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white leading-tight">PSeInt Converter</h1>
              <p className="text-[10px] sm:text-xs text-slate-400 font-medium uppercase tracking-widest">AI-Powered Transpiler</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {/* Controles scrollables */}
            <div className="flex items-center gap-3 overflow-x-auto pb-1 sm:pb-0 scrollbar-hide flex-1 sm:flex-none">
            {/* Selector de modelo */}
            <div className="flex bg-[#0d1117] rounded-lg p-1 border border-white/5 shrink-0">
              {/* Groq siempre visible */}
              <button
                onClick={() => setSelectedModel("groq")}
                title={`Groq — ${GROQ_MODELS.find((m) => m.id === groqModel)?.label ?? groqModel}`}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap",
                  selectedModel === "groq"
                    ? "bg-orange-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                )}
              >
                <Zap className="w-3 h-3" />
                Groq
              </button>
              {enabledModels.gemini && (
                <button
                  onClick={() => setSelectedModel("gemini")}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap",
                    selectedModel === "gemini"
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                  )}
                >
                  <Sparkles className="w-3 h-3" />
                  Gemini
                </button>
              )}
            </div>

            {/* Campo API Key */}
            {selectedModel === "gemini" && (
              <div className="flex items-center gap-1.5 bg-[#0d1117] border border-white/5 rounded-lg px-2 py-1 w-48 sm:w-56 shrink-0">
                <KeyRound className="w-3 h-3 text-slate-500 shrink-0" />
                <input
                  type={showApiKey ? "text" : "password"}
                  value={geminiApiKey}
                  onChange={(e) => {
                    setGeminiApiKey(e.target.value);
                    localStorage.setItem("gemini_api_key", e.target.value);
                  }}
                  placeholder="API Key de Gemini"
                  spellCheck={false}
                  className="flex-1 bg-transparent text-xs text-slate-300 placeholder-slate-600 outline-none min-w-0"
                />
                <button onClick={() => setShowApiKey((v) => !v)} className="text-slate-600 hover:text-slate-400 transition-colors shrink-0" title={showApiKey ? "Ocultar clave" : "Mostrar clave"}>
                  {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}
            {selectedModel === "groq" && (
              <div className="flex items-center gap-1.5 bg-[#0d1117] border border-white/5 rounded-lg px-2 py-1 w-48 sm:w-56 shrink-0">
                <KeyRound className="w-3 h-3 text-slate-500 shrink-0" />
                <input
                  type={showApiKey ? "text" : "password"}
                  value={groqApiKey}
                  onChange={(e) => {
                    setGroqApiKey(e.target.value);
                    localStorage.setItem("groq_api_key", e.target.value);
                  }}
                  placeholder="API Key de Groq"
                  spellCheck={false}
                  className="flex-1 bg-transparent text-xs text-slate-300 placeholder-slate-600 outline-none min-w-0"
                />
                <button onClick={() => setShowApiKey((v) => !v)} className="text-slate-600 hover:text-slate-400 transition-colors shrink-0" title={showApiKey ? "Ocultar clave" : "Mostrar clave"}>
                  {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}

            {/* Selector de lenguaje */}
            <div className="flex bg-[#0d1117] rounded-lg p-1 border border-white/5 w-full sm:w-auto">
              {(["Python", "C", "C++", "Rust"] as TargetLanguage[]).map((lang) => (
                <button
                  key={lang}
                  onClick={() => setLanguage(lang)}
                  className={cn(
                    "flex-1 sm:flex-none px-3 sm:px-4 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap",
                    language === lang
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                  )}
                >
                  {lang}
                </button>
              ))}
            </div>

            </div>{/* fin controles scrollables */}

            {/* Botón de configuración — fuera del overflow para que el panel no se recorte */}
            <div className="relative shrink-0">
              <button
                onClick={() => setShowSettings((v) => !v)}
                className={cn(
                  "w-8 h-8 flex items-center justify-center rounded-lg border transition-all",
                  showSettings
                    ? "bg-white/10 border-white/20 text-white"
                    : "bg-[#0d1117] border-white/5 text-slate-400 hover:text-slate-200 hover:bg-white/5"
                )}
                title="Configuración de modelos"
              >
                <Settings className="w-4 h-4" />
              </button>

              {showSettings && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
                  <div className="fixed top-[4.5rem] right-4 w-72 bg-[#0d1117] border border-white/10 rounded-2xl shadow-2xl shadow-black/80 z-50 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                      <div className="flex items-center gap-2">
                        <Settings className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-xs font-semibold text-slate-200">Modelos de IA</span>
                      </div>
                      <button
                        onClick={() => setShowSettings(false)}
                        className="w-5 h-5 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/10 transition-all"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>

                    <div className="p-2">
                      {/* Groq */}
                      <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-orange-500/5 border border-orange-500/10 mb-1">
                        <div className="w-7 h-7 rounded-lg bg-orange-500/10 flex items-center justify-center shrink-0">
                          <Zap className="w-3.5 h-3.5 text-orange-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="text-xs font-semibold text-slate-100">Groq</p>
                            <span className="text-[9px] font-bold uppercase tracking-wider text-orange-500 bg-orange-500/10 px-1.5 py-0.5 rounded-full">Default</span>
                          </div>
                          <p className="text-[10px] text-slate-500 truncate">
                            {GROQ_MODELS.find((m) => m.id === groqModel)?.label ?? groqModel}
                          </p>
                        </div>
                        <div className="w-9 h-5 bg-orange-500 rounded-full relative shrink-0 opacity-60 cursor-not-allowed">
                          <div className="absolute right-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow" />
                        </div>
                      </div>

                      {/* Selector de modelo Groq */}
                      <div className="mb-1 px-1">
                        <p className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold mb-1 px-2">Modelo Groq</p>
                        <div className="flex flex-col gap-0.5">
                          {GROQ_MODELS.map((m) => (
                            <button
                              key={m.id}
                              onClick={() => setGroqModel(m.id)}
                              className={cn(
                                "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-all",
                                groqModel === m.id
                                  ? "bg-orange-500/10 border border-orange-500/20"
                                  : "hover:bg-white/5 border border-transparent"
                              )}
                            >
                              <div className={cn(
                                "w-3 h-3 rounded-full border-2 shrink-0 transition-colors",
                                groqModel === m.id ? "border-orange-500 bg-orange-500" : "border-slate-600"
                              )} />
                              <div className="flex-1 min-w-0">
                                <span className={cn("text-[11px] font-semibold", groqModel === m.id ? "text-orange-300" : "text-slate-300")}>
                                  {m.label}
                                </span>
                                <span className="text-[9px] text-slate-500 ml-1.5">{m.description}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Gemini */}
                      <button
                        onClick={() => toggleModel("gemini")}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border mb-1 transition-all text-left",
                          enabledModels.gemini ? "bg-indigo-500/5 border-indigo-500/10" : "bg-white/[0.02] border-white/5 hover:bg-white/5"
                        )}
                      >
                        <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", enabledModels.gemini ? "bg-indigo-500/10" : "bg-white/5")}>
                          <Sparkles className={cn("w-3.5 h-3.5", enabledModels.gemini ? "text-indigo-400" : "text-slate-500")} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={cn("text-xs font-semibold", enabledModels.gemini ? "text-slate-100" : "text-slate-500")}>Gemini</p>
                          <p className="text-[10px] text-slate-600 truncate">gemini-2.0-flash</p>
                        </div>
                        <div className={cn("w-9 h-5 rounded-full relative shrink-0 transition-colors", enabledModels.gemini ? "bg-indigo-500" : "bg-white/10")}>
                          <div className={cn("absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all", enabledModels.gemini ? "right-0.5" : "left-0.5")} />
                        </div>
                      </button>

                      {/* Agentes IA */}
                      <div className="mt-1 pt-2 border-t border-white/5">
                        <button
                          onClick={() => toggleModel("agents")}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left",
                            enabledModels.agents ? "bg-violet-500/5 border-violet-500/10" : "bg-white/[0.02] border-white/5 hover:bg-white/5"
                          )}
                        >
                          <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", enabledModels.agents ? "bg-violet-500/10" : "bg-white/5")}>
                            <BrainCircuit className={cn("w-3.5 h-3.5", enabledModels.agents ? "text-violet-400" : "text-slate-500")} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={cn("text-xs font-semibold", enabledModels.agents ? "text-slate-100" : "text-slate-500")}>Agentes IA</p>
                            <p className="text-[10px] text-slate-600 truncate">Agente, Debate de Bugs, Código Limpio</p>
                          </div>
                          <div className={cn("w-9 h-5 rounded-full relative shrink-0 transition-colors", enabledModels.agents ? "bg-violet-500" : "bg-white/10")}>
                            <div className={cn("absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all", enabledModels.agents ? "right-0.5" : "left-0.5")} />
                          </div>
                        </button>

                        {/* Sugerir corrección */}
                        <button
                          onClick={() => toggleModel("suggestFix")}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left mt-1",
                            enabledModels.suggestFix ? "bg-violet-500/5 border-violet-500/10" : "bg-white/[0.02] border-white/5 hover:bg-white/5"
                          )}
                        >
                          <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", enabledModels.suggestFix ? "bg-violet-500/10" : "bg-white/5")}>
                            <Wrench className={cn("w-3.5 h-3.5", enabledModels.suggestFix ? "text-violet-400" : "text-slate-500")} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={cn("text-xs font-semibold", enabledModels.suggestFix ? "text-slate-100" : "text-slate-500")}>Sugerir corrección</p>
                            <p className="text-[10px] text-slate-600 truncate">Corrección automática por test fallido</p>
                          </div>
                          <div className={cn("w-9 h-5 rounded-full relative shrink-0 transition-colors", enabledModels.suggestFix ? "bg-violet-500" : "bg-white/10")}>
                            <div className={cn("absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all", enabledModels.suggestFix ? "right-0.5" : "left-0.5")} />
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4 sm:py-8">
        <div className={cn("flex flex-col lg:grid lg:grid-cols-2 gap-6", !showExplainer && "lg:h-[calc(100vh-10rem)]")}>
          {/* Input Section */}
          <section className="flex flex-col gap-3 h-[400px] sm:h-[500px] lg:h-full">
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-2 text-slate-400">
                <Terminal className="w-4 h-4" />
                <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider">Pseudocódigo PSeInt</span>
              </div>
              <button 
                onClick={() => setInput("")}
                className="text-[10px] sm:text-xs text-slate-500 hover:text-indigo-400 transition-colors"
              >
                Limpiar
              </button>
            </div>
            <div className="flex-1 relative group min-h-0 bg-[#161b22] border border-white/5 rounded-2xl overflow-auto custom-scrollbar">
              <Editor
                value={input}
                onValueChange={code => setInput(code)}
                highlight={code => Prism.highlight(code, Prism.languages.pseint, 'pseint')}
                padding={20}
                className="font-mono text-xs sm:text-sm min-h-full"
                style={{
                  fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                  fontSize: 'inherit',
                  lineHeight: '1.5',
                }}
                textareaClassName="focus:outline-none"
              />
              <button
                onClick={handleConvert}
                disabled={loading || !input.trim()}
                className={cn(
                  "absolute bottom-4 right-4 sm:bottom-6 sm:right-6 px-4 py-2 sm:px-6 sm:py-3 rounded-xl font-bold text-xs sm:text-sm flex items-center gap-2 transition-all shadow-xl z-10",
                  loading || !input.trim()
                    ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                    : selectedModel === "groq"
                        ? "bg-orange-600 text-white hover:bg-orange-500 active:scale-95 shadow-orange-500/20"
                        : "bg-indigo-600 text-white hover:bg-indigo-500 active:scale-95 shadow-indigo-500/20"
                )}
              >
                {loading ? (
                  <RefreshCw className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" />
                ) : selectedModel === "groq" ? (
                  <Zap className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                ) : (
                  <Languages className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                )}
                {!loading
                  ? "Convertir Código"
                  : lastConvertStep?.type === "verifying"
                  ? "Verificando…"
                  : lastConvertStep?.type === "fixing_compile"
                  ? `Corrigiendo (${lastConvertStep.attempt}/3)…`
                  : "Convirtiendo…"}
              </button>
            </div>
          </section>

          {/* Output Section */}
          <section className="flex flex-col gap-3 h-[400px] sm:h-[500px] lg:h-full">
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-2 text-slate-400">
                <Code2 className="w-4 h-4" />
                <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider">Código {language}</span>
                {/* Badge de verificación de compilación */}
                {loading && lastConvertStep?.type === "verifying" && (
                  <span className="flex items-center gap-1 text-[10px] text-slate-500">
                    <Loader className="w-3 h-3 animate-spin" />verificando…
                  </span>
                )}
                {loading && lastConvertStep?.type === "fixing_compile" && (
                  <span className="flex items-center gap-1 text-[10px] text-orange-400">
                    <Wrench className="w-3 h-3 animate-pulse" />corrigiendo error…
                  </span>
                )}
                {!loading && lastConvertStep?.type === "done" && lastConvertStep.verified && (
                  <span className={cn("flex items-center gap-1 text-[10px]", lastConvertStep.fixed ? "text-blue-400" : "text-emerald-400")}>
                    <ShieldCheck className="w-3 h-3" />
                    {lastConvertStep.fixed ? "errores corregidos ✓" : "compilado ✓"}
                  </span>
                )}
              </div>
              {output && !loading && (
              <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      setShowRunner((v) => !v);
                      if (showExplainer) setShowExplainer(false);
                      if (showAgent) setShowAgent(false);
                      if (showDebate) setShowDebate(false);
                      if (showCleanCode) setShowCleanCode(false);
                    }}
                    className={cn(
                      "flex items-center gap-1.5 text-[10px] sm:text-xs transition-colors",
                      showRunner ? "text-emerald-400" : "text-slate-400 hover:text-emerald-400"
                    )}
                  >
                    <Play className="w-3.5 h-3.5" />
                    {showRunner ? "Ocultar" : "Ejecutar"}
                  </button>
                  <button
                    onClick={() => {
                      if (!showExplainer) {
                        setShowExplainer(true);
                        setShowRunner(false);
                        setShowAgent(false);
                        setShowDebate(false);
                        setShowCleanCode(false);
                        if (chatMessages.length === 0) {
                          sendExplainMessage("Explícame paso a paso cómo funciona el código generado y cómo se tradujeron las estructuras de PSeInt.");
                        }
                      } else {
                        setShowExplainer(false);
                      }
                    }}
                    className={cn(
                      "flex items-center gap-1.5 text-[10px] sm:text-xs transition-colors",
                      showExplainer ? "text-indigo-400" : "text-slate-400 hover:text-indigo-400"
                    )}
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    {showExplainer ? "Ocultar" : "Explicar"}
                  </button>
                  {/* Botón Agente */}
                  {enabledModels.agents && (
                  <button
                    onClick={() => {
                      if (showAgent) {
                        setShowAgent(false);
                      } else if (agentResult) {
                        // Ya corrió — solo mostrar resultados sin volver a ejecutar
                        setShowAgent(true);
                        setShowRunner(false);
                        setShowExplainer(false);
                        setShowCleanCode(false);
                        setShowDebate(false);
                      } else {
                        handleRunAgent();
                      }
                    }}
                    disabled={agentRunning || !groqApiKey}
                    title={!groqApiKey ? "Necesitas una API Key de Groq" : ""}
                    className={cn(
                      "flex items-center gap-1.5 text-[10px] sm:text-xs transition-colors",
                      agentRunning
                        ? "text-violet-400 cursor-wait"
                        : showAgent
                        ? "text-violet-400"
                        : "text-slate-400 hover:text-violet-400 disabled:opacity-40 disabled:cursor-not-allowed"
                    )}
                  >
                    {agentRunning
                      ? <Loader className="w-3.5 h-3.5 animate-spin" />
                      : <BrainCircuit className="w-3.5 h-3.5" />}
                    Agente
                  </button>
                  )}
                  {/* Botón Código Limpio */}
                  {enabledModels.agents && (
                  <button
                    onClick={() => {
                      if (!showCleanCode) {
                        handleGenerateCleanCode();
                      } else {
                        setShowCleanCode(false);
                      }
                    }}
                    disabled={cleanCodeLoading || !groqApiKey}
                    title={!groqApiKey ? "Necesitas una API Key de Groq" : ""}
                    className={cn(
                      "flex items-center gap-1.5 text-[10px] sm:text-xs transition-colors",
                      cleanCodeLoading
                        ? "text-amber-400 cursor-wait"
                        : showCleanCode
                        ? "text-amber-400"
                        : "text-slate-400 hover:text-amber-400 disabled:opacity-40 disabled:cursor-not-allowed"
                    )}
                  >
                    {cleanCodeLoading
                      ? <Loader className="w-3.5 h-3.5 animate-spin" />
                      : <Wand2 className="w-3.5 h-3.5" />}
                    Código Limpio
                  </button>
                  )}
                  <button
                    onClick={copyToClipboard}
                    className="flex items-center gap-1.5 text-[10px] sm:text-xs text-slate-400 hover:text-indigo-400 transition-colors"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? "Copiado" : "Copiar"}
                  </button>
                </div>
              )}
            </div>
            <div className="flex-1 bg-[#0d1117] border border-white/5 rounded-2xl overflow-hidden relative min-h-0">
                {/* Removed AnimatePresence */}
                {!output && !loading && !error ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 p-8 text-center">
                    <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                      <Terminal className="w-6 h-6 sm:w-8 sm:h-8 opacity-20" />
                    </div>
                    <p className="text-xs sm:text-sm font-medium">El código convertido aparecerá aquí</p>
                    <p className="text-[10px] sm:text-xs mt-1 opacity-60">Selecciona un lenguaje y presiona convertir</p>
                  </div>
                ) : error ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400 p-8 text-center">
                    <AlertCircle className="w-8 h-8 sm:w-10 sm:h-10 mb-4 opacity-50" />
                    <p className="text-xs sm:text-sm font-medium">{error}</p>
                  </div>
                ) : (
                  <Editor
                    value={output}
                    onValueChange={setOutput}
                    highlight={(code) => {
                      const lang = getPrismLanguage(language);
                      if (Prism.languages[lang]) {
                        try { return Prism.highlight(code, Prism.languages[lang], lang); }
                        catch { return code; }
                      }
                      return code;
                    }}
                    padding={20}
                    className="font-mono text-xs sm:text-sm min-h-full"
                    style={{
                      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                      fontSize: 'inherit',
                      lineHeight: '1.5',
                    }}
                    textareaClassName="focus:outline-none"
                  />
                )}
              
              {loading && (
                <div className="absolute inset-0 bg-[#0d1117]/60 backdrop-blur-[2px] flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3 w-56 px-4">
                    <div className="w-8 h-8 sm:w-10 sm:h-10 border-2 rounded-full animate-spin border-indigo-500/30 border-t-indigo-500" />
                    <div className="flex flex-col items-center gap-2 w-52">
                        <span className="text-[10px] sm:text-xs font-medium text-center"
                          style={{ color: selectedModel === "groq" ? "rgb(251 146 60)" : "rgb(129 140 248)" }}>
                          {selectedModel === "groq" ? "Procesando con Groq..." : "Procesando con Gemini..."}
                        </span>
                        {/* Barra indeterminada */}
                        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-1 w-1/3 rounded-full"
                            style={{
                              background: selectedModel === "groq" ? "rgb(234 88 12)" : "rgb(99 102 241)",
                              animation: "slide 1.4s ease-in-out infinite"
                            }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-slate-500">
                          {inferenceElapsed.toFixed(1)}s transcurridos
                        </span>
                      </div>
                  </div>
                </div>
              )}

            </div>
          </section>
        </div>

        {/* ── Explainer Chat Panel ── */}
        {showExplainer && output && (
          <div className="mt-6">
            <div className="bg-[#161b22] border border-indigo-500/20 rounded-2xl overflow-hidden flex flex-col h-96 shadow-xl shadow-indigo-900/10">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-[#0d1117]/40 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                    <Bot className="w-3.5 h-3.5 text-indigo-400" />
                  </div>
                  <span className="text-xs font-semibold text-slate-200">Tutor IA — Explicación interactiva</span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded-full">
                    {selectedModel === "gemini" ? "Gemini" : "Groq"}
                  </span>
                </div>
                <button
                  onClick={() => setShowExplainer(false)}
                  className="w-6 h-6 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/10 transition-all"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Messages */}
              <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                {chatMessages.map((msg, i) => (
                  <div key={i} className={cn("flex gap-3 items-start", msg.role === "user" && "flex-row-reverse")}>
                    <div className={cn(
                      "w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5",
                      msg.role === "user" ? "bg-indigo-600" : "bg-[#0d1117] border border-white/10"
                    )}>
                      {msg.role === "user"
                        ? <User className="w-3.5 h-3.5 text-white" />
                        : <Bot className="w-3.5 h-3.5 text-indigo-400" />
                      }
                    </div>
                    <div className={cn(
                      "max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed",
                      msg.role === "user"
                        ? "bg-indigo-600 text-white rounded-tr-sm"
                        : "bg-[#0d1117]/70 text-slate-200 border border-white/5 rounded-tl-sm"
                    )}>
                      {msg.role === "assistant"
                        ? <ReactMarkdown components={markdownComponents}>{msg.content}</ReactMarkdown>
                        : msg.content
                      }
                    </div>
                  </div>
                ))}

                {/* Streaming response */}
                {streamingMessage && (
                  <div className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-xl bg-[#0d1117] border border-white/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="w-3.5 h-3.5 text-indigo-400" />
                    </div>
                    <div className="max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-xs leading-relaxed bg-[#0d1117]/70 text-slate-200 border border-white/5">
                      <ReactMarkdown components={markdownComponents}>{streamingMessage}</ReactMarkdown>
                      <span className="inline-block w-0.5 h-3 bg-indigo-400 animate-pulse ml-0.5 align-middle" />
                    </div>
                  </div>
                )}

                {/* Loading dots */}
                {chatLoading && !streamingMessage && (
                  <div className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-xl bg-[#0d1117] border border-white/10 flex items-center justify-center shrink-0">
                      <Bot className="w-3.5 h-3.5 text-indigo-400" />
                    </div>
                    <div className="rounded-2xl rounded-tl-sm px-4 py-3 bg-[#0d1117]/70 border border-white/5 flex items-center gap-1.5">
                      {[0, 150, 300].map((delay) => (
                        <span key={delay} className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: `${delay}ms` }} />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Input bar */}
              <form onSubmit={handleSendMessage} className="border-t border-white/5 p-3 flex gap-2 shrink-0 bg-[#0d1117]/20">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Pregunta sobre el código…"
                  disabled={chatLoading}
                  autoFocus
                  className="flex-1 bg-[#0d1117] border border-white/5 rounded-xl px-4 py-2 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500/40 transition-colors disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={chatLoading || !chatInput.trim()}
                  className="w-9 h-9 flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 rounded-xl text-white transition-colors shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ── Code Runner + Test Panel ── */}
        {showRunner && output && (
          <div className="mt-6 space-y-0">
            <div className="bg-[#161b22] border border-emerald-500/20 rounded-2xl overflow-hidden shadow-xl shadow-emerald-900/10">

              {/* ── Header ── */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-[#0d1117]/40 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    <Play className="w-3.5 h-3.5 text-emerald-400" />
                  </div>
                  <span className="text-xs font-semibold text-slate-200">Entorno de ejecución</span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                    {language === "Python" ? "Pyodide WASM" : "Wandbox API"}
                  </span>
                </div>
                <button
                  onClick={() => setShowRunner(false)}
                  className="w-6 h-6 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/10 transition-all"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* ── Input / Output split ── */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 divide-x divide-white/5">
                {/* Stdin */}
                <div className="flex flex-col p-4 gap-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    <Terminal className="w-3 h-3" />
                    Entrada (stdin)
                  </div>
                  <textarea
                    value={runInput}
                    onChange={(e) => setRunInput(e.target.value)}
                    placeholder={"Datos de entrada\n(uno por línea, según Leer del pseudocódigo)"}
                    className="flex-1 min-h-[96px] bg-[#0d1117] border border-white/5 rounded-xl p-3 font-mono text-xs text-slate-300 placeholder-slate-600 resize-none outline-none focus:border-emerald-500/40 transition-colors"
                  />
                  <button
                    onClick={() => handleRun()}
                    disabled={runLoading}
                    className={cn(
                      "flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all",
                      runLoading
                        ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                        : "bg-emerald-600 hover:bg-emerald-500 text-white active:scale-95 shadow-lg shadow-emerald-900/20"
                    )}
                  >
                    {runLoading
                      ? <><Loader className="w-3.5 h-3.5 animate-spin" />{pyodideProgress ? `Cargando Pyodide ${Math.round((pyodideProgress.loaded / Math.max(pyodideProgress.total, 1)) * 100)}%…` : "Ejecutando…"}</>
                      : <><Play className="w-3.5 h-3.5" />▶ Ejecutar</>
                    }
                  </button>
                </div>

                {/* Stdout/stderr */}
                <div className="flex flex-col p-4 gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      <Code2 className="w-3 h-3" />
                      Salida
                    </div>
                    {runResult && (
                      <span className={cn(
                        "text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full",
                        runResult.exitCode === 0 ? "text-emerald-400 bg-emerald-500/10" : "text-red-400 bg-red-500/10"
                      )}>
                        {runResult.exitCode === 0 ? "OK" : `Exit ${runResult.exitCode}`}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-h-[96px] bg-black/40 border border-white/5 rounded-xl p-3 font-mono text-xs overflow-auto">
                    {runLoading && !runResult && (
                      <span className="text-slate-500 animate-pulse">Esperando ejecución…</span>
                    )}
                    {!runLoading && !runResult && (
                      <span className="text-slate-600">Presiona ▶ Ejecutar</span>
                    )}
                    {runResult && (
                      <>
                        {runResult.compileError && (
                          <span className="text-amber-400 whitespace-pre-wrap">[Error de compilación]\n{runResult.compileError}</span>
                        )}
                        {runResult.stdout && (
                          <span className="text-emerald-300 whitespace-pre-wrap">{runResult.stdout}</span>
                        )}
                        {runResult.stderr && !runResult.compileError && (
                          <span className="text-red-400 whitespace-pre-wrap">{runResult.stderr}</span>
                        )}
                        {!runResult.stdout && !runResult.stderr && !runResult.compileError && (
                          <span className="text-slate-500">(sin salida)</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Test Cases Section ── */}
              <div className="border-t border-white/5">
                {/* Test header */}
                <div className="flex items-center justify-between px-4 py-3 bg-[#0d1117]/20">
                  <div className="flex items-center gap-2">
                    <FlaskConical className="w-3.5 h-3.5 text-violet-400" />
                    <span className="text-xs font-semibold text-slate-200">Casos de prueba IA</span>
                    {testCases.length > 0 && (
                      <span className="text-[9px] font-bold bg-white/10 text-slate-400 px-1.5 py-0.5 rounded-full">
                        {testCases.length}
                      </span>
                    )}
                    {testCases.length > 0 && testResults.some((r) => r.status !== "pending" && r.status !== "running") && (
                      <span className={cn(
                        "text-[9px] font-bold px-1.5 py-0.5 rounded-full",
                        testResults.every((r) => r.status === "pass")
                          ? "text-emerald-400 bg-emerald-500/10"
                          : "text-red-400 bg-red-500/10"
                      )}>
                        {testResults.filter((r) => r.status === "pass").length}/{testResults.length} pasaron
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleGenerateTests}
                      disabled={generatingTests || !output}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all border",
                        generatingTests
                          ? "border-white/5 text-slate-500 cursor-not-allowed bg-transparent"
                          : "border-violet-500/20 text-violet-400 hover:bg-violet-500/10 bg-transparent active:scale-95"
                      )}
                    >
                      {generatingTests
                        ? <><Loader className="w-3 h-3 animate-spin" />Generando…</>
                        : <><Sparkles className="w-3 h-3" />✨ Generar tests</>
                      }
                    </button>
                    {testCases.length > 0 && (
                      <button
                        onClick={handleRunAllTests}
                        disabled={testRunning}
                        className={cn(
                          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all border",
                          testRunning
                            ? "border-white/5 text-slate-500 cursor-not-allowed bg-transparent"
                            : "border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10 bg-transparent active:scale-95"
                        )}
                      >
                        {testRunning
                          ? <><Loader className="w-3 h-3 animate-spin" />Probando…</>
                          : <><Play className="w-3 h-3" />▶ Probar todos</>
                        }
                      </button>
                    )}
                    {/* Debate bug button — solo si agentes activos */}
                    {enabledModels.agents && testResults.some((r) => r.status !== "pass" && r.status !== "pending") && !testRunning && groqApiKey && (
                      <button
                        onClick={() => handleStartDebate(testResults.filter((r) => r.status !== "pass" && r.status !== "pending"))}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all border border-red-500/20 text-red-400 hover:bg-red-500/10 bg-transparent active:scale-95"
                      >
                        <Swords className="w-3 h-3" />
                        Debatir bug
                      </button>
                    )}
    {/* Botón corregir global eliminado — la sugerencia es por prueba */}
                  </div>
                </div>

                {/* Test list */}
                {testResults.length > 0 && (
                  <div className="divide-y divide-white/5">
                    {testResults.map((tr) => {
                      const isExpanded = expandedTests.has(tr.id);
                      const statusColor =
                        tr.status === "pass" ? "text-emerald-400" :
                        tr.status === "fail" ? "text-red-400" :
                        tr.status === "error" ? "text-amber-400" :
                        tr.status === "running" ? "text-blue-400" :
                        "text-slate-500";
                      const bgColor =
                        tr.status === "pass" ? "bg-emerald-500/5" :
                        tr.status === "fail" ? "bg-red-500/5" :
                        tr.status === "error" ? "bg-amber-500/5" : "";

                      return (
                        <div key={tr.id} className={cn("transition-colors", bgColor)}>
                          {/* Row */}
                          <button
                            onClick={() => toggleTestExpand(tr.id)}
                            className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors text-left"
                          >
                            {/* Status icon */}
                            <span className="shrink-0">
                              {tr.status === "pass" && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                              {tr.status === "fail" && <XCircle className="w-4 h-4 text-red-400" />}
                              {tr.status === "error" && <AlertCircle className="w-4 h-4 text-amber-400" />}
                              {tr.status === "running" && <Loader className="w-4 h-4 text-blue-400 animate-spin" />}
                              {tr.status === "pending" && <div className="w-4 h-4 rounded-full border border-white/20" />}
                            </span>

                            {/* Description */}
                            <span className={cn("flex-1 text-xs font-medium truncate", statusColor === "text-slate-500" ? "text-slate-400" : statusColor)}>
                              {tr.description}
                            </span>

                            {/* Input preview */}
                            <span className="text-[10px] text-slate-600 font-mono truncate max-w-[120px]">
                              {tr.input ? `→ ${tr.input.replace(/\n/g, " ")}` : "sin entrada"}
                            </span>

                            {/* Status badge */}
                            <span className={cn("text-[9px] font-bold uppercase tracking-wider shrink-0", statusColor)}>
                              {tr.status === "pass" ? "PASS" :
                               tr.status === "fail" ? "FAIL" :
                               tr.status === "error" ? "ERROR" :
                               tr.status === "running" ? "···" : "—"}
                            </span>

                            {/* Expand toggle */}
                            <span className="text-slate-600 shrink-0">
                              {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </span>
                          </button>

                          {/* Expanded detail */}
                          {isExpanded && (
                            <div className="px-4 pb-3 space-y-3">
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[10px] font-mono">
                                <div>
                                  <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Entrada</div>
                                  <pre className="bg-black/30 rounded-lg p-2 text-slate-300 whitespace-pre-wrap break-all">{tr.input || "(vacío)"}</pre>
                                </div>
                                <div>
                                  <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Esperado</div>
                                  <pre className="bg-black/30 rounded-lg p-2 text-slate-300 whitespace-pre-wrap break-all">{tr.expectedOutput || "(vacío)"}</pre>
                                </div>
                                <div>
                                  <div className={cn("text-[9px] uppercase tracking-wider mb-1", tr.status === "pass" ? "text-emerald-600" : "text-red-600")}>
                                    Obtenido
                                  </div>
                                  <pre className={cn(
                                    "rounded-lg p-2 whitespace-pre-wrap break-all",
                                    tr.status === "pass" ? "bg-emerald-900/20 text-emerald-300" :
                                    tr.status === "fail" ? "bg-red-900/20 text-red-300" :
                                    "bg-black/30 text-slate-300"
                                  )}>
                                    {tr.actualOutput || tr.error || "(vacío)"}
                                  </pre>
                                </div>
                              </div>

                              {/* AI explanation for failed tests */}
                              {tr.status === "fail" && (testExplanations[tr.id] || streamingExplanations[tr.id]) && (
                                <div className="bg-amber-950/30 border border-amber-500/20 rounded-xl p-3 flex gap-2.5">
                                  <Bot className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                                  <div className="text-[11px] text-amber-100/80 leading-relaxed font-sans">
                                    <ReactMarkdown components={markdownComponents}>
                                      {testExplanations[tr.id] || streamingExplanations[tr.id]}
                                    </ReactMarkdown>
                                    {streamingExplanations[tr.id] && (
                                      <span className="inline-block w-0.5 h-3 bg-amber-400 animate-pulse ml-0.5 align-middle" />
                                    )}
                                  </div>
                                </div>
                              )}
                              {tr.status === "fail" && !testExplanations[tr.id] && !streamingExplanations[tr.id] && !testRunning && (
                                <div className="bg-amber-950/20 border border-amber-500/10 rounded-xl p-3 flex gap-2.5 items-center opacity-50">
                                  <Bot className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                  <span className="text-[11px] text-amber-200/60 font-sans">Generando explicación…</span>
                                  <Loader className="w-3 h-3 text-amber-400 animate-spin ml-1" />
                                </div>
                              )}

                              {/* ── Sugerir corrección por prueba ── */}
                              {(tr.status === "fail" || tr.status === "error") && groqApiKey && enabledModels.suggestFix && (
                                <div>
                                  {/* Botón sugerir */}
                                  {!testSuggestions[tr.id] && (
                                    <button
                                      onClick={() => handleSuggestFix(tr.id)}
                                      disabled={!!testSuggestionLoading[tr.id]}
                                      className={cn(
                                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all border bg-transparent active:scale-95",
                                        testSuggestionLoading[tr.id]
                                          ? "border-white/5 text-slate-500 cursor-wait"
                                          : "border-violet-500/20 text-violet-400 hover:bg-violet-500/10"
                                      )}
                                    >
                                      {testSuggestionLoading[tr.id]
                                        ? <><Loader className="w-3 h-3 animate-spin" />Analizando…</>
                                        : <><Wrench className="w-3 h-3" />Sugerir corrección</>
                                      }
                                    </button>
                                  )}

                                  {/* Diff inline */}
                                  {testSuggestions[tr.id] && (
                                    <div className="rounded-xl overflow-hidden border border-violet-500/20">
                                      <div className="px-3 py-2 bg-[#0d1117]/60 flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                          <Wrench className="w-3 h-3 text-violet-400 shrink-0" />
                                          <span className="text-[10px] font-semibold text-slate-300">Corrección sugerida</span>
                                          <span className="text-[9px] text-slate-500">
                                            <span className="text-emerald-400">+añadido</span>
                                            {" · "}
                                            <span className="text-red-400">−eliminado</span>
                                          </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {testSuggestions[tr.id] !== output ? (
                                            <>
                                              <button
                                                onClick={() => {
                                                  setOutput(testSuggestions[tr.id]);
                                                  setTestSuggestions((prev) => {
                                                    const next = { ...prev };
                                                    delete next[tr.id];
                                                    return next;
                                                  });
                                                }}
                                                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-all active:scale-95"
                                              >
                                                <Check className="w-3 h-3" />
                                                Aceptar
                                              </button>
                                              <button
                                                onClick={() => setTestSuggestions((prev) => {
                                                  const next = { ...prev }; delete next[tr.id]; return next;
                                                })}
                                                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-all active:scale-95"
                                              >
                                                <X className="w-3 h-3" />
                                                Rechazar
                                              </button>
                                            </>
                                          ) : (
                                            <span className="text-[9px] text-emerald-500 font-semibold">✓ Aplicado</span>
                                          )}
                                        </div>
                                      </div>
                                      <CodeDiffView
                                        oldCode={output}
                                        newCode={testSuggestions[tr.id]}
                                        monacoLang={toMonacoLang(language)}
                                      />
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Empty state */}
                {testCases.length === 0 && !generatingTests && (
                  <div className="flex flex-col items-center justify-center py-6 text-slate-600 gap-2">
                    <FlaskConical className="w-6 h-6 opacity-30" />
                    <p className="text-xs">Genera tests con IA para verificar tu código automáticamente</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Agent Progress Panel ── */}
        {showAgent && output && enabledModels.agents && (
          <div className="mt-6">
            <div className="bg-[#161b22] border border-violet-500/20 rounded-2xl overflow-hidden shadow-xl shadow-violet-900/10">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-[#0d1117]/40 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-violet-500/10 flex items-center justify-center">
                    <BrainCircuit className="w-3.5 h-3.5 text-violet-400" />
                  </div>
                  <span className="text-xs font-semibold text-slate-200">Agente IA — Verificación Autónoma</span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded-full">
                    {agentRunning ? "En curso" : agentResult?.success ? "Éxito" : agentResult ? "Completado" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {agentResult && !agentResult.success && (
                    <button
                      onClick={() => handleStartDebate(agentResult.results.filter((r) => r.status !== "pass"))}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-all"
                    >
                      <Swords className="w-3 h-3" />
                      Debatir bug
                    </button>
                  )}
                  {agentResult && agentResult.code !== output && (
                    <button
                      onClick={() => {
                        setOutput(agentResult.code);
                        if (agentResult.results.length > 0) {
                          setTestResults(agentResult.results);
                          setTestCases(agentResult.results.map(({ id, description, input: inp, expectedOutput }) => ({
                            id, description, input: inp, expectedOutput,
                          })));
                        }
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold border border-violet-500/20 text-violet-400 hover:bg-violet-500/10 transition-all"
                    >
                      <Wrench className="w-3 h-3" />
                      Aplicar código
                    </button>
                  )}
                  <button
                    onClick={() => setShowAgent(false)}
                    className="w-6 h-6 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/10 transition-all"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Steps timeline */}
              <div className="p-4 space-y-1.5">
                {agentSteps.map((step, i) => {
                  const isLast = i === agentSteps.length - 1;

                  let icon: React.ReactNode;
                  let label: string;
                  let color: string;

                  if (step.type === "start") {
                    icon = <BrainCircuit className="w-3.5 h-3.5 text-violet-400" />;
                    label = "Iniciando bucle agentico…";
                    color = "text-violet-300";
                  } else if (step.type === "generating_tests") {
                    icon = isLast && agentRunning
                      ? <Loader className="w-3.5 h-3.5 text-violet-400 animate-spin" />
                      : <Sparkles className="w-3.5 h-3.5 text-violet-400" />;
                    label = "Generando casos de prueba…";
                    color = "text-violet-300";
                  } else if (step.type === "tests_generated") {
                    icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
                    label = `${step.tests.length} casos de prueba generados`;
                    color = "text-emerald-300";
                  } else if (step.type === "running_tests") {
                    icon = <Loader className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
                    label = `Ejecutando test ${step.current}/${step.total}…`;
                    color = "text-blue-300";
                  } else if (step.type === "tests_complete") {
                    const ok = step.passed === step.total;
                    icon = ok
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      : <XCircle className="w-3.5 h-3.5 text-red-400" />;
                    label = `${step.passed}/${step.total} tests pasaron`;
                    color = ok ? "text-emerald-300" : "text-red-300";
                  } else if (step.type === "fixing") {
                    icon = <Wrench className="w-3.5 h-3.5 text-amber-400 animate-pulse" />;
                    label = `Intento ${step.attempt}/${3}: corrigiendo ${step.failCount} fallo(s)…`;
                    color = "text-amber-300";
                  } else if (step.type === "code_updated") {
                    icon = <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" />;
                    label = "Código actualizado por el agente";
                    color = "text-amber-300";
                  } else if (step.type === "done") {
                    icon = step.success
                      ? <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      : <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
                    label = step.success
                      ? `✓ Todos los tests pasan — ${step.attempts} intento(s)`
                      : `Máx. intentos alcanzado — ${step.results.filter(r => r.status === "pass").length}/${step.results.length} tests pasan`;
                    color = step.success ? "text-emerald-300" : "text-red-300";
                  } else if (step.type === "error") {
                    icon = <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
                    label = step.message;
                    color = "text-red-300";
                  } else {
                    icon = null; label = ""; color = "";
                  }

                  return (
                    <div key={i} className="flex items-center gap-3 py-1">
                      <div className="w-5 h-5 flex items-center justify-center shrink-0">{icon}</div>
                      <span className={cn("text-xs font-mono", color)}>{label}</span>
                      {isLast && agentRunning && step.type !== "running_tests" && step.type !== "generating_tests" && (
                        <span className="inline-flex gap-0.5 ml-1">
                          {[0, 100, 200].map((d) => (
                            <span key={d} className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
                          ))}
                        </span>
                      )}
                    </div>
                  );
                })}

                {agentSteps.length === 0 && agentRunning && (
                  <div className="flex items-center gap-3 py-2">
                    <Loader className="w-4 h-4 text-violet-400 animate-spin" />
                    <span className="text-xs text-violet-300">Iniciando agente…</span>
                  </div>
                )}
              </div>

              {/* ── Resumen de tests ── */}
              {agentResult && agentResult.results.length > 0 && (
                <div className="border-t border-white/5">
                  <div className="px-4 py-2 flex items-center gap-2 bg-[#0d1117]/20">
                    <FlaskConical className="w-3.5 h-3.5 text-violet-400" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Resultados de tests</span>
                    <span className={cn(
                      "text-[9px] font-bold px-1.5 py-0.5 rounded-full",
                      agentResult.success ? "text-emerald-400 bg-emerald-500/10" : "text-red-400 bg-red-500/10"
                    )}>
                      {agentResult.results.filter(r => r.status === "pass").length}/{agentResult.results.length} PASS
                    </span>
                  </div>
                  <div className="divide-y divide-white/5">
                    {agentResult.results.map((r) => (
                      <div key={r.id} className={cn(
                        "grid grid-cols-[1.25rem_1fr_auto] items-start gap-3 px-4 py-2.5 text-xs",
                        r.status === "pass" ? "bg-emerald-500/[0.03]" : "bg-red-500/[0.04]"
                      )}>
                        <span className="mt-0.5 shrink-0">
                          {r.status === "pass"
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            : <XCircle className="w-3.5 h-3.5 text-red-400" />}
                        </span>
                        <div className="min-w-0">
                          <p className={cn("font-medium truncate", r.status === "pass" ? "text-emerald-300" : "text-red-300")}>
                            {r.description}
                          </p>
                          {r.status !== "pass" && (
                            <div className="mt-1.5 grid grid-cols-2 gap-2 font-mono text-[10px]">
                              <div>
                                <span className="text-slate-500 block mb-0.5">Esperado</span>
                                <pre className="bg-black/30 rounded px-2 py-1 text-slate-300 whitespace-pre-wrap break-all">{r.expectedOutput || "(vacío)"}</pre>
                              </div>
                              <div>
                                <span className="text-red-500 block mb-0.5">Obtenido</span>
                                <pre className="bg-red-900/20 rounded px-2 py-1 text-red-200 whitespace-pre-wrap break-all">{r.actualOutput || r.error || "(vacío)"}</pre>
                              </div>
                            </div>
                          )}
                          {r.status === "pass" && r.input && (
                            <span className="text-slate-600 font-mono text-[10px]">entrada: {r.input.replace(/\n/g, " · ")}</span>
                          )}
                        </div>
                        <span className={cn(
                          "text-[9px] font-bold uppercase tracking-wider shrink-0 mt-0.5",
                          r.status === "pass" ? "text-emerald-500" : "text-red-500"
                        )}>
                          {r.status === "pass" ? "PASS" : r.status === "error" ? "ERR" : "FAIL"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Código final del agente ── */}
              {agentResult && (() => {
                const codeChanged = agentResult.code !== output || agentResult.success;
                return codeChanged ? (
                  <div className="border-t border-white/5">
                    <div className="px-4 py-2 flex items-center justify-between bg-[#0d1117]/20">
                      <div className="flex items-center gap-2">
                        <Code2 className="w-3.5 h-3.5 text-violet-400" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          {agentResult.success ? "Código verificado" : "Mejor versión encontrada"}
                        </span>
                        {agentResult.attempts > 1 && (
                          <span className="text-[9px] text-slate-500">{agentResult.attempts} intento(s)</span>
                        )}
                        {agentResult.code !== output && (
                          <span className="text-[9px] text-slate-500">— revisa los cambios
                            <span className="ml-1 text-emerald-500">verde = añadido</span>
                            , <span className="text-red-400">rojo = eliminado</span>
                          </span>
                        )}
                      </div>
                      {agentResult.code !== output ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              setOutput(agentResult.code);
                              if (agentResult.results.length > 0) {
                                setTestResults(agentResult.results);
                                setTestCases(agentResult.results.map(({ id, description, input: inp, expectedOutput }) => ({
                                  id, description, input: inp, expectedOutput,
                                })));
                              }
                            }}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-all active:scale-95"
                          >
                            <Check className="w-3 h-3" />
                            Aceptar cambios
                          </button>
                          <button
                            onClick={() => setAgentResult({ ...agentResult, code: output })}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[10px] font-semibold border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-all active:scale-95"
                          >
                            <X className="w-3 h-3" />
                            Rechazar
                          </button>
                        </div>
                      ) : (
                        <span className="text-[9px] text-emerald-500 font-semibold">✓ Cambios aplicados</span>
                      )}
                    </div>
                    <CodeDiffView oldCode={output} newCode={agentResult.code} monacoLang={toMonacoLang(language)} />
                  </div>
                ) : null;
              })()}
            </div>
          </div>
        )}

        {/* ── Debate Panel ── */}
        {showDebate && output && enabledModels.agents && (
          <div className="mt-6">
            <div className="bg-[#161b22] border border-red-500/20 rounded-2xl overflow-hidden shadow-xl shadow-red-900/10">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-[#0d1117]/40 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-red-500/10 flex items-center justify-center">
                    <Swords className="w-3.5 h-3.5 text-red-400" />
                  </div>
                  <span className="text-xs font-semibold text-slate-200">Debate de Bugs — 2 Agentes</span>
                  {debateRunning && (
                    <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full animate-pulse">
                      En debate…
                    </span>
                  )}
                  {!debateRunning && debateMessages.length > 0 && (
                    <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                      Consenso alcanzado
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* Aplicar código del consenso */}
                  {(() => {
                    const consensus = debateMessages.find((m) => m.agent === "consensus" && !m.isStreaming);
                    return consensus?.proposedCode ? (
                      consensus.proposedCode === output ? (
                        <span className="text-[9px] text-emerald-500 font-semibold">✓ Cambios aplicados</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setOutput(consensus.proposedCode!)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-all active:scale-95"
                          >
                            <Check className="w-3 h-3" />
                            Aceptar consenso
                          </button>
                          <button
                            onClick={() => {
                              // descarta: marca como si ya fuera el output actual para no mostrar diff
                              setDebateMessages((prev) =>
                                prev.map((m) =>
                                  m.id === consensus.id ? { ...m, proposedCode: output } : m
                                )
                              );
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-all active:scale-95"
                          >
                            <X className="w-3 h-3" />
                            Rechazar
                          </button>
                        </div>
                      )
                    ) : null;
                  })()}
                  <button
                    onClick={() => setShowDebate(false)}
                    className="w-6 h-6 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/10 transition-all"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Messages */}
              <div className="p-4 space-y-4">
                {debateMessages.map((msg) => {
                  const isAlfa = msg.agent === "debugger";
                  const isBeta = msg.agent === "architect";
                  const isConsensus = msg.agent === "consensus";

                  const header = isAlfa
                    ? { label: "Ronda 1 — Agente Alfa · Debugger", color: "text-red-400", bg: "bg-red-500/5 border-red-500/15", avatar: "bg-red-500/10", icon: <Swords className="w-3.5 h-3.5 text-red-400" /> }
                    : isBeta
                    ? { label: "Ronda 2 — Agente Beta · Arquitecto", color: "text-blue-400", bg: "bg-blue-500/5 border-blue-500/15", avatar: "bg-blue-500/10", icon: <ShieldCheck className="w-3.5 h-3.5 text-blue-400" /> }
                    : { label: "Consenso Final", color: "text-emerald-400", bg: "bg-emerald-500/5 border-emerald-500/15", avatar: "bg-emerald-500/10", icon: <Scale className="w-3.5 h-3.5 text-emerald-400" /> };

                  return (
                    <div key={msg.id} className={cn("rounded-xl border p-4", header.bg)}>
                      <div className="flex items-center gap-2 mb-3">
                        <div className={cn("w-6 h-6 rounded-lg flex items-center justify-center", header.avatar)}>
                          {header.icon}
                        </div>
                        <span className={cn("text-[10px] font-bold uppercase tracking-wider", header.color)}>
                          {header.label}
                        </span>
                        {msg.isStreaming && (
                          <span className="inline-flex gap-0.5 ml-1">
                            {[0, 100, 200].map((d) => (
                              <span key={d} className="w-1 h-1 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
                            ))}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-300 leading-relaxed">
                        <ReactMarkdown components={markdownComponents}>{msg.content}</ReactMarkdown>
                        {msg.isStreaming && (
                          <span className="inline-block w-0.5 h-3 bg-slate-400 animate-pulse ml-0.5 align-middle" />
                        )}
                      </div>
                      {/* Diff view del código propuesto por el consenso */}
                      {isConsensus && msg.proposedCode && !msg.isStreaming && msg.proposedCode !== output && (
                        <div className="mt-3 rounded-xl overflow-hidden border border-emerald-500/15">
                          <div className="px-3 py-1.5 bg-[#0d1117]/60 flex items-center gap-2 border-b border-white/5">
                            <span className="text-[10px] font-semibold text-slate-400">Código propuesto —</span>
                            <span className="text-[9px] text-emerald-400">verde = añadido</span>
                            <span className="text-[9px] text-slate-500">·</span>
                            <span className="text-[9px] text-red-400">rojo = eliminado</span>
                          </div>
                          <CodeDiffView oldCode={output} newCode={msg.proposedCode} monacoLang={toMonacoLang(language)} />
                        </div>
                      )}
                      {isConsensus && msg.proposedCode && !msg.isStreaming && msg.proposedCode === output && (
                        <p className="mt-2 text-[10px] text-emerald-500 font-semibold">✓ Cambios ya aplicados al editor</p>
                      )}
                    </div>
                  );
                })}

                {debateRunning && debateMessages.length === 0 && (
                  <div className="flex items-center gap-3 py-4 justify-center">
                    <Loader className="w-4 h-4 text-red-400 animate-spin" />
                    <span className="text-xs text-slate-400">Los agentes están analizando el bug…</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Clean Code Thread Panel ── */}
        {showCleanCode && output && enabledModels.agents && (
          <div className="mt-6">
            <div className="bg-[#161b22] border border-amber-500/20 rounded-2xl overflow-hidden shadow-xl shadow-amber-900/10">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-[#0d1117]/40 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-amber-500/10 flex items-center justify-center">
                    <Wand2 className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                  <span className="text-xs font-semibold text-slate-200">Hilo de Código Limpio</span>
                  {cleanCodeItems.length > 0 && (
                    <span className="text-[9px] font-bold bg-white/10 text-slate-400 px-1.5 py-0.5 rounded-full">
                      {cleanCodeItems.length} sugerencias
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setShowCleanCode(false)}
                  className="w-6 h-6 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/10 transition-all"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Loading */}
              {cleanCodeLoading && (
                <div className="p-6 flex flex-col items-center gap-3">
                  <Loader className="w-6 h-6 text-amber-400 animate-spin" />
                  <span className="text-xs text-slate-400">Analizando código con Clean Code principles…</span>
                  {cleanCodePartial && (
                    <div className="w-full max-h-24 overflow-hidden bg-black/30 rounded-xl p-2 font-mono text-[9px] text-slate-500 opacity-50">
                      {cleanCodePartial.slice(-200)}
                    </div>
                  )}
                </div>
              )}

              {/* Thread items */}
              {!cleanCodeLoading && cleanCodeItems.length > 0 && (
                <div className="divide-y divide-white/5">
                  {cleanCodeItems.map((item) => {
                    const isExpanded = expandedCleanCode.has(item.id);
                    const priorityConfig: Record<string, { color: string; bg: string; label: string }> = {
                      critical: { color: "text-red-400",    bg: "bg-red-500/10",    label: "CRÍTICO" },
                      high:     { color: "text-amber-400",  bg: "bg-amber-500/10",  label: "ALTO"    },
                      medium:   { color: "text-blue-400",   bg: "bg-blue-500/10",   label: "MEDIO"   },
                      low:      { color: "text-slate-400",  bg: "bg-slate-500/10",  label: "BAJO"    },
                    };
                    const levelConfig: Record<string, { color: string; bg: string; label: string; dot: string }> = {
                      basica:  { color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Básica",  dot: "bg-emerald-400" },
                      media:   { color: "text-yellow-400",  bg: "bg-yellow-500/10",  label: "Media",   dot: "bg-yellow-400"  },
                      experta: { color: "text-purple-400",  bg: "bg-purple-500/10",  label: "Experta", dot: "bg-purple-400"  },
                    };
                    const pc = priorityConfig[item.priority];
                    const lc = levelConfig[item.level] ?? levelConfig["media"];

                    return (
                      <div key={item.id}>
                        <button
                          onClick={() => setExpandedCleanCode((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })}
                          className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
                        >
                          <span className="text-xs font-bold tabular-nums text-slate-500 w-5 shrink-0">
                            #{item.threadIndex}
                          </span>
                          {/* Prioridad */}
                          <span className={cn("text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0", pc.bg, pc.color)}>
                            {pc.label}
                          </span>
                          {/* Nivel de modificación */}
                          <span className={cn("flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0", lc.bg, lc.color)}>
                            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", lc.dot)} />
                            {lc.label}
                          </span>
                          <span className="flex-1 text-xs font-semibold text-slate-200 text-left truncate">{item.title}</span>
                          <span className="text-slate-600 shrink-0">
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="px-4 pb-4 space-y-2">
                            <div className="bg-[#0d1117]/60 rounded-xl p-4 border border-white/5 text-xs text-slate-300 leading-relaxed">
                              <ReactMarkdown components={markdownComponents}>{item.body}</ReactMarkdown>
                            </div>
                            {item.reference && (
                              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/15">
                                <span className="text-amber-400 text-[10px] shrink-0">📖</span>
                                <span className="text-[10px] text-amber-200/70 italic">{item.reference}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Debate button for failed tests */}
              {!cleanCodeLoading && cleanCodeItems.length > 0 && testResults.some(r => r.status !== "pass") && (
                <div className="px-4 py-3 border-t border-white/5 flex justify-end">
                  <button
                    onClick={() => handleStartDebate(testResults.filter(r => r.status !== "pass"))}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-all"
                  >
                    <Swords className="w-3 h-3" />
                    Debatir bugs pendientes
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-4 py-6 border-t border-white/5 mt-auto">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <p className="text-[10px] sm:text-xs text-slate-500 text-center md:text-left">
            © {new Date().getFullYear()} PSeInt Converter. Powered by{" "}
            {selectedModel === "groq" ? `Groq — ${GROQ_MODELS.find((m) => m.id === groqModel)?.label ?? groqModel}` : "Gemini 2.0 Flash"}.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
            <a href="#" className="text-[10px] sm:text-xs text-slate-500 hover:text-slate-300 transition-colors">Documentación</a>
            <a href="#" className="text-[10px] sm:text-xs text-slate-500 hover:text-slate-300 transition-colors">Soporte</a>
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[9px] sm:text-[10px] font-bold text-emerald-500 uppercase tracking-wider">AI System Active</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
