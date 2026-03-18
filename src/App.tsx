import { useState, useEffect, useRef } from "react";
import { convertPSeInt, TargetLanguage } from "./services/geminiService";
import { convertPSeIntGroq, GROQ_MODEL } from "./services/groqService";
import { convertPSeIntLocal, isModelLoaded, ModelLoadProgress } from "./services/localModelService";
import { Code2, Copy, Check, Terminal, Languages, RefreshCw, AlertCircle, Cpu, Sparkles, KeyRound, Eye, EyeOff, Zap, Settings, X } from "lucide-react";
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

const EXAMPLE_PSEINT = `Algoritmo SumaDeDosNumeros
    Definir num1, num2, resultado Como Entero
    Escribir "Ingrese el primer número:"
    Leer num1
    Escribir "Ingrese el segundo número:"
    Leer num2
    resultado <- num1 + num2
    Escribir "La suma es: ", resultado
FinAlgoritmo`;

type ModelType = "gemini" | "groq" | "local";

type EnabledModels = { gemini: boolean; local: boolean };

function loadEnabledModels(): EnabledModels {
  try {
    const raw = localStorage.getItem("enabled_models");
    if (raw) return JSON.parse(raw) as EnabledModels;
  } catch { /* ignore */ }
  // Por defecto solo Groq activo; Gemini y Local desactivados
  return { gemini: false, local: false };
}

export default function App() {
  const [input, setInput] = useState(EXAMPLE_PSEINT);
  const [output, setOutput] = useState("");
  const [language, setLanguage] = useState<TargetLanguage>("Python");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelType>("groq");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelProgress, setModelProgress] = useState<number>(0);
  const [modelProgressFile, setModelProgressFile] = useState<string>("");
  const [localModelReady, setLocalModelReady] = useState(() => isModelLoaded());
  const [geminiApiKey, setGeminiApiKey] = useState<string>(
    () => localStorage.getItem("gemini_api_key") ?? process.env.GEMINI_API_KEY ?? ""
  );
  const [groqApiKey, setGroqApiKey] = useState<string>(
    () => localStorage.getItem("groq_api_key") ?? ""
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [enabledModels, setEnabledModels] = useState<EnabledModels>(loadEnabledModels);
  const [showSettings, setShowSettings] = useState(false);
  const [inferenceTokens, setInferenceTokens] = useState(0);
  const [inferenceElapsed, setInferenceElapsed] = useState(0);
  const inferenceStartRef = useRef<number | null>(null);
  const inferenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const prismLang = getPrismLanguage(language);
    if (codeRef.current) {
      if (output) {
        if (Prism.languages && Prism.languages[prismLang]) {
          try {
            const html = Prism.highlight(output, Prism.languages[prismLang], prismLang);
            codeRef.current.innerHTML = html;
          } catch (err) {
            console.error("Prism highlighting error:", err);
            codeRef.current.textContent = output;
          }
        } else {
          codeRef.current.textContent = output;
        }
      } else {
        codeRef.current.innerHTML = "";
      }
    }
  }, [output, language]);

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

  const handleModelProgress = (p: ModelLoadProgress) => {
    if (p.status === "progress" && typeof p.progress === "number") {
      setModelProgress(Math.round(p.progress));
      if (p.file) setModelProgressFile(p.file);
    } else if (p.status === "initiate" && p.file) {
      setModelProgressFile(p.file);
    } else if (p.status === "ready") {
      setLocalModelReady(true);
      setModelLoading(false);
    }
  };

  const handleConvert = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    setInferenceTokens(0);
    setInferenceElapsed(0);

    // Arrancar el timer global desde el inicio (sirve para Gemini y para local antes del primer token)
    inferenceStartRef.current = performance.now();
    inferenceTimerRef.current = setInterval(() => {
      if (inferenceStartRef.current) {
        setInferenceElapsed(
          (performance.now() - inferenceStartRef.current) / 1000
        );
      }
    }, 200);

    try {
      let result: string;
      if (selectedModel === "local") {
        if (!localModelReady) {
          setModelLoading(true);
          setModelProgress(0);
        }
        result = await convertPSeIntLocal(
          input,
          language,
          (p) => { handleModelProgress(p); },
          (count) => {
            setInferenceTokens(count);
          }
        );
        setLocalModelReady(true);
        setModelLoading(false);
      } else if (selectedModel === "groq") {
        result = await convertPSeIntGroq(input, language, groqApiKey);
      } else {
        result = await convertPSeInt(input, language, geminiApiKey || undefined);
      }
      setOutput(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("GEMINI_API_KEY") || message.includes("GROQ_API_KEY")) {
        setError("Falta la clave de API. Ingrésala en el campo correspondiente o usa el modelo Local.");
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
      setModelLoading(false);
      // Detener y limpiar el timer
      if (inferenceTimerRef.current) {
        clearInterval(inferenceTimerRef.current);
        inferenceTimerRef.current = null;
      }
      inferenceStartRef.current = null;
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
                title={`Groq — ${GROQ_MODEL}`}
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
              {enabledModels.local && (
                <button
                  onClick={() => setSelectedModel("local")}
                  title="Qwen2.5-Coder-0.5B-Instruct — se ejecuta localmente en el navegador"
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap",
                    selectedModel === "local"
                      ? "bg-violet-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                  )}
                >
                  <Cpu className="w-3 h-3" />
                  Local
                  {selectedModel === "local" && localModelReady && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  )}
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
                          <p className="text-[10px] text-slate-500 truncate">{GROQ_MODEL}</p>
                        </div>
                        <div className="w-9 h-5 bg-orange-500 rounded-full relative shrink-0 opacity-60 cursor-not-allowed">
                          <div className="absolute right-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow" />
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

                      {/* Local */}
                      <button
                        onClick={() => toggleModel("local")}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left",
                          enabledModels.local ? "bg-violet-500/5 border-violet-500/10" : "bg-white/[0.02] border-white/5 hover:bg-white/5"
                        )}
                      >
                        <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", enabledModels.local ? "bg-violet-500/10" : "bg-white/5")}>
                          <Cpu className={cn("w-3.5 h-3.5", enabledModels.local ? "text-violet-400" : "text-slate-500")} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className={cn("text-xs font-semibold", enabledModels.local ? "text-slate-100" : "text-slate-500")}>Local</p>
                            {enabledModels.local && localModelReady && (
                              <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">Listo</span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-600 truncate">Qwen2.5-Coder-0.5B · en navegador</p>
                        </div>
                        <div className={cn("w-9 h-5 rounded-full relative shrink-0 transition-colors", enabledModels.local ? "bg-violet-500" : "bg-white/10")}>
                          <div className={cn("absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all", enabledModels.local ? "right-0.5" : "left-0.5")} />
                        </div>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4 sm:py-8">
        <div className="flex flex-col lg:grid lg:grid-cols-2 gap-6 lg:h-[calc(100vh-10rem)]">
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
                    : selectedModel === "local"
                      ? "bg-violet-600 text-white hover:bg-violet-500 active:scale-95 shadow-violet-500/20"
                      : selectedModel === "groq"
                        ? "bg-orange-600 text-white hover:bg-orange-500 active:scale-95 shadow-orange-500/20"
                        : "bg-indigo-600 text-white hover:bg-indigo-500 active:scale-95 shadow-indigo-500/20"
                )}
              >
                {loading ? (
                  <RefreshCw className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" />
                ) : selectedModel === "local" ? (
                  <Cpu className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                ) : selectedModel === "groq" ? (
                  <Zap className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                ) : (
                  <Languages className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                )}
                {loading
                  ? modelLoading
                    ? "Descargando modelo..."
                    : "Convirtiendo..."
                  : selectedModel === "local" && !localModelReady
                    ? "Cargar y Convertir"
                    : "Convertir Código"}
              </button>
            </div>
          </section>

          {/* Output Section */}
          <section className="flex flex-col gap-3 h-[400px] sm:h-[500px] lg:h-full">
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-2 text-slate-400">
                <Code2 className="w-4 h-4" />
                <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider">Código {language}</span>
              </div>
              {output && (
                <button
                  onClick={copyToClipboard}
                  className="flex items-center gap-1.5 text-[10px] sm:text-xs text-slate-400 hover:text-indigo-400 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copiado" : "Copiar"}
                </button>
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
                  <pre className="w-full h-full p-4 sm:p-6 overflow-auto font-mono text-xs sm:text-sm">
                    <code 
                      ref={codeRef}
                      className={`language-${getPrismLanguage(language)}`}
                    />
                  </pre>
                )}
              
              {loading && (
                <div className="absolute inset-0 bg-[#0d1117]/60 backdrop-blur-[2px] flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3 w-56 px-4">
                    <div className={cn(
                      "w-8 h-8 sm:w-10 sm:h-10 border-2 rounded-full animate-spin",
                      modelLoading
                        ? "border-violet-500/30 border-t-violet-500"
                        : "border-indigo-500/30 border-t-indigo-500"
                    )} />
                    {modelLoading ? (
                      <>
                        <span className="text-[10px] sm:text-xs font-medium text-violet-400 animate-pulse text-center">
                          Descargando modelo local... {modelProgress > 0 && `${modelProgress}%`}
                        </span>
                        {modelProgress > 0 && (
                          <div className="w-full bg-white/10 rounded-full h-1.5">
                            <div
                              className="bg-violet-500 h-1.5 rounded-full transition-all duration-300"
                              style={{ width: `${modelProgress}%` }}
                            />
                          </div>
                        )}
                        {modelProgressFile && (
                          <span className="text-[9px] text-slate-500 truncate max-w-full text-center">
                            {modelProgressFile}
                          </span>
                        )}
                      </>
                    ) : (
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
                    )}
                  </div>
                </div>
              )}

              {/* Barra de estado de inferencia local */}
              {loading && selectedModel === "local" && !modelLoading && inferenceTokens > 0 && (
                <div className="absolute bottom-0 left-0 right-0 px-4 py-2 bg-[#0d1117]/90 border-t border-violet-500/20 flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                      <span className="font-mono">
                        {inferenceTokens} tokens
                        {inferenceElapsed > 0 && (
                          <span className="text-violet-400 ml-2">
                            · {(inferenceTokens / inferenceElapsed).toFixed(1)} tok/s
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-slate-500">
                        {inferenceElapsed.toFixed(1)}s
                      </span>
                    </div>
                    <div className="w-full bg-white/5 rounded-full h-1 overflow-hidden">
                      <div
                        className="h-1 rounded-full bg-gradient-to-r from-violet-600 to-violet-400 transition-all duration-200"
                        style={{ width: `${Math.min((inferenceTokens / 1024) * 100, 98)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-4 py-6 border-t border-white/5 mt-auto">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <p className="text-[10px] sm:text-xs text-slate-500 text-center md:text-left">
            © {new Date().getFullYear()} PSeInt Converter. Powered by{" "}
            {selectedModel === "local" ? "Qwen2.5-Coder-0.5B (local)" : selectedModel === "groq" ? `Groq — ${GROQ_MODEL}` : "Gemini 2.0 Flash"}.
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
