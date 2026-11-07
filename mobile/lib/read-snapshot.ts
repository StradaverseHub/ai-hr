/** Short-lived display snapshots. Owned by one unlocked tree; never written to disk. */
export function createReadSnapshots(now = Date.now, ttl = 30_000, capacity = 16) {
  const entries = new Map<string, { value: unknown; expires: number }>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (key: string) => { for (const listener of listeners.get(key) ?? []) listener(); };
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
      notify(key);
    },
    remove(key: string) { if (entries.delete(key)) notify(key); },
    subscribe(key: string, listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set<() => void>();
      subscribers.add(listener); listeners.set(key, subscribers);
      return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(key); };
    },
    activate() { closed = false; },
    dispose() { closed = true; entries.clear(); listeners.clear(); },
  };
}
