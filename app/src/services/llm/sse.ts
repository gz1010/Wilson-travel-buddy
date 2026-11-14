/**
 * Parses an OpenAI-style server-sent event stream ("data: {...}\n\n") as it
 * arrives in pieces. Feed it the whole response text so far; it remembers
 * how much it has already read.
 */
export class SSEParser {
  private offset = 0;
  done = false;

  /** Returns the content deltas found in text added since the last call. */
  feed(fullText: string): string[] {
    const out: string[] = [];
    let end: number;
    while ((end = fullText.indexOf('\n', this.offset)) !== -1) {
      const line = fullText.slice(this.offset, end).replace(/\r$/, '');
      this.offset = end + 1;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        this.done = true;
        continue;
      }
      try {
        const json = JSON.parse(data);
        if (json.error) throw new Error(json.error.message ?? String(json.error));
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) out.push(delta);
      } catch (e) {
        if (e instanceof SyntaxError) continue; // a partial line; wait for more
        throw e;
      }
    }
    return out;
  }
}
