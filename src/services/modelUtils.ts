// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de normalización de salida de modelos
// Algunos modelos (p.ej. Qwen3) emiten bloques <think>…</think> de
// cadena de razonamiento antes de la respuesta real.
// Estas utilidades los eliminan tanto en respuestas completas como en streaming.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Elimina todos los bloques <think>…</think> (incluyendo multilínea) de una
 * respuesta completa ya recibida.
 */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Filtro con estado para respuestas en streaming.
 * Acumula los segmentos <think>…</think> internamente y solo deja pasar
 * el contenido visible al caller.
 *
 * Uso:
 *   const filter = new ThinkStreamFilter();
 *   for await (const chunk of stream) {
 *     const visible = filter.feed(chunk);
 *     if (visible) yield visible;
 *   }
 *   const tail = filter.flush();
 *   if (tail) yield tail;
 */
export class ThinkStreamFilter {
  private buf = "";
  private inThink = false;

  feed(chunk: string): string {
    this.buf += chunk;
    let out = "";

    while (true) {
      if (this.inThink) {
        const end = this.buf.indexOf("</think>");
        if (end === -1) {
          // El tag de cierre puede estar partido entre chunks — conservar los
          // últimos 8 caracteres por si llegan en el siguiente chunk.
          const safe = Math.max(0, this.buf.length - 8);
          this.buf = this.buf.slice(safe);
          break;
        }
        this.buf = this.buf.slice(end + 8); // 8 === "</think>".length
        this.inThink = false;
      } else {
        const start = this.buf.indexOf("<think>");
        if (start === -1) {
          // Sin tag de apertura — emitir todo excepto los últimos 7 caracteres
          // por si el inicio de "<think>" llega en el siguiente chunk.
          const safe = Math.max(0, this.buf.length - 7);
          out += this.buf.slice(0, safe);
          this.buf = this.buf.slice(safe);
          break;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7); // 7 === "<think>".length
        this.inThink = true;
      }
    }

    return out;
  }

  /** Llamar al final del stream para vaciar el buffer restante. */
  flush(): string {
    if (this.inThink) {
      this.buf = "";
      return "";
    }
    const out = this.buf;
    this.buf = "";
    return out;
  }
}
