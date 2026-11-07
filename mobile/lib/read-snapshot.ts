/** Short-lived display snapshots. Owned by one unlocked tree; never written to disk. */
export function createReadSnapshots(now = Date.now, ttl = 30_000, capacity = 16) {
  const entries = new Map<string, { value: unknown; expires: number }>();
  let closed = false;
  return {
    get<T>(key: string): T | undefined {
      const entry = entries.get(key);
      if (closed || !entry || entry.expires <= now()) { entries.delete(key); return; }
      return entry.value as T;
    },
    put(key: string, value: unknown) {
      if (closed) return;
      entries.delete(key);
      if (entries.size >= capacity) entries.delete(entries.keys().next().value!);
      entries.set(key, { value, expires: now() + ttl });
    },
    remove(key: string) { entries.delete(key); },
    activate() { closed = false; },
    dispose() { closed = true; entries.clear(); },
  };
}
