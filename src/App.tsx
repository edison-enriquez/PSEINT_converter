import { useState, useEffect, useRef } from "react";
import { convertPSeInt, TargetLanguage } from "./services/geminiService";
import { Code2, Copy, Check, Terminal, Languages, RefreshCw, AlertCircle } from "lucide-react";
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

export default function App() {
  const [input, setInput] = useState(EXAMPLE_PSEINT);
  const [output, setOutput] = useState("");
  const [language, setLanguage] = useState<TargetLanguage>("Python");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  const handleConvert = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await convertPSeInt(input, language);
      setOutput(result);
    } catch (err) {
      setError("Error al convertir el código. Inténtalo de nuevo.");
      console.error(err);
    } finally {
      setLoading(false);
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
          
          <div className="flex items-center gap-4 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0 scrollbar-hide">
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
                    : "bg-indigo-600 text-white hover:bg-indigo-500 active:scale-95 shadow-indigo-500/20"
                )}
              >
                {loading ? (
                  <RefreshCw className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" />
                ) : (
                  <Languages className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                )}
                {loading ? "Convirtiendo..." : "Convertir Código"}
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
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 sm:w-10 sm:h-10 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
                    <span className="text-[10px] sm:text-xs font-medium text-indigo-400 animate-pulse">Procesando con IA...</span>
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
            © {new Date().getFullYear()} PSeInt Converter. Powered by Gemini 3.1 Pro.
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
