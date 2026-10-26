/** Bound bytes AND elapsed time, including a stalled body after headers. No background retry. */
export class BodyReadError extends Error {}
export async function readBoundedBody(response: Pick<Response, 'body' | 'headers'>, maximum: number, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    void response.body?.cancel().catch(() => {});
    throw new BodyReadError('Body too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BodyReadError('Body required');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    abort = () => { void reader.cancel().catch(() => {}); reject(new BodyReadError('Body read interrupted')); };
    timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([(async () => {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) { void reader.cancel().catch(() => {}); throw new BodyReadError('Body too large'); }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    })(), expired]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* A pending native read may still own its lock after cancellation. */ }
  }
}
