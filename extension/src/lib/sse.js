// Line-based stream readers for SSE and NDJSON responses.

// Yield complete lines (without terminators) from a fetch Response body.
async function* lines(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      // Split on \n; strip an optional trailing \r
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        yield line;
      }
    }
    buf += dec.decode();
    if (buf.endsWith('\r')) buf = buf.slice(0, -1);
    if (buf) yield buf; // final line without newline
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

// Yield the payload of each `data:` line, trimmed.
export async function* sseData(response) {
  for await (const line of lines(response)) {
    if (line.startsWith('data:')) yield line.slice(5).trim();
    // comments (":") and other fields (event:, id:, retry:) are skipped
  }
}

// Yield each non-empty line.
export async function* ndjsonLines(response) {
  for await (const line of lines(response)) {
    const t = line.trim();
    if (t) yield t;
  }
}
