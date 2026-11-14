/**
 * Collects streamed tokens and hands out whole sentences, so the voice can
 * start on the first sentence while the model is still writing the rest.
 */
export class SentenceChunker {
  private buffer = '';

  /** Adds a token; returns any sentences it completed. */
  push(token: string): string[] {
    this.buffer += token;
    const out: string[] = [];
    // A sentence ends at . ! ? followed by a space, unless it is a number like "3.5".
    const re = /[^.!?…]*[.!?…]+(?=\s)/g;
    let m: RegExpExecArray | null;
    let consumed = 0;
    while ((m = re.exec(this.buffer))) {
      const s = this.buffer.slice(consumed, m.index + m[0].length).trim();
      if (s.length >= 2) {
        out.push(s);
        consumed = m.index + m[0].length;
      }
    }
    this.buffer = this.buffer.slice(consumed);
    return out;
  }

  /** Whatever is left when the stream ends. */
  flush(): string[] {
    const s = this.buffer.trim();
    this.buffer = '';
    return s ? [s] : [];
  }
}
