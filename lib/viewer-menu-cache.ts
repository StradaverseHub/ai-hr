import { createHash } from 'node:crypto';

/**
 * ADR 0181 Phase 3, decision 3: the cached viewer menu profile (owner decision 25 November 2026, "access version +
 * 60 s").
 *
 * The app frame's menu visibility (which destinations the rail shows) is near-constant per viewer, yet its definer
 * functions cost about 1.1 s of database work on every frame draw on staging. This cache keeps those answers per web
 * process, keyed by:
 *  - the tenant and the viewer's session claims (user, person, roles, grants, entitlements), so any change to the
 *    session itself is a different key;
 *  - the tenant's access version (app.viewer_access_version(), migration 7260): every change to roles, access
 *    memberships, groups, grants, overrides, the access configuration and the company tree increments it in the
 *    changing transaction, so such a change is visible on the next draw;
 *  - the HR date, so a fact that turns on a date changes at midnight Kuala Lumpur time.
 * Facts that also depend on business data (contract cases, postings, probation cases, reward units) are bounded by
 * the time limit: an entry is never served after MAX_AGE_MS.
 *
 * What it never holds: work queues and counts (they are read live), and anything a page, action or service uses to
 * decide. Menus fail open by design (lib/nav-entitlements.ts); every destination still checks its own authority and
 * fails closed.
 *
 * Bounded memory: at most MAX_ENTRIES entries per process, least recently used first out. An entry is a few kilobytes.
 * A read that fails or degrades is not cached. Concurrent misses for one key share one read.
 */
export const VIEWER_MENU_MAX_AGE_MS = 60_000;
export const VIEWER_MENU_MAX_ENTRIES = 1_000;

type Entry<T> = { storedAt: number; value: Promise<T>; settled: boolean };

/** Whether the cache serves reads. Off only by AIHR_VIEWER_MENU_CACHE=off (an operator switch for comparison). */
export function viewerMenuCacheEnabled(): boolean {
  return process.env.AIHR_VIEWER_MENU_CACHE !== 'off';
}

/** A stable digest of the session claims that decide menu visibility. Key order does not matter. */
export function sessionClaimsDigest(claims: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(stable(claims) ?? null)).digest('base64url');
}

/** Read outcome: the value and whether it may be kept (false when any part fell back to a default after a failure). */
export type MenuRead<T> = { value: T; cacheable: boolean };

export class ViewerMenuCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  constructor(
    private readonly maxAgeMs = VIEWER_MENU_MAX_AGE_MS,
    private readonly maxEntries = VIEWER_MENU_MAX_ENTRIES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get size(): number { return this.entries.size; }

  /** The cached value for `key`, or `read()`'s, kept when it settles cacheable. */
  async get<T>(key: string, read: () => Promise<MenuRead<T>>): Promise<T> {
    const found = this.entries.get(key) as Entry<T> | undefined;
    if (found && this.now() - found.storedAt < this.maxAgeMs) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, found);
      return found.value;
    }
    if (found) this.entries.delete(key);
    const storedAt = this.now();
    let resolveValue!: (value: T) => void;
    let rejectValue!: (reason: unknown) => void;
    const value = new Promise<T>((resolve, reject) => { resolveValue = resolve; rejectValue = reject; });
    const entry: Entry<T> = { storedAt, value, settled: false };
    this.entries.set(key, entry as Entry<unknown>);
    this.evict();
    try {
      const outcome = await read();
      entry.settled = true;
      if (!outcome.cacheable && this.entries.get(key) === entry) this.entries.delete(key);
      resolveValue(outcome.value);
      return outcome.value;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      rejectValue(error);
      // A waiter on this entry sees the same failure; nothing is kept.
      value.catch(() => undefined);
      throw error;
    }
  }

  private evict() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  clear() { this.entries.clear(); }
}

const globalCache = globalThis as unknown as { __aihrViewerMenuCache?: ViewerMenuCache };
/** The process's cache (one per web process; survives hot reload in development). */
export function viewerMenuCache(): ViewerMenuCache {
  return (globalCache.__aihrViewerMenuCache ??= new ViewerMenuCache());
}
