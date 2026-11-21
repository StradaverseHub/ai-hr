import type { SessionContext } from '../db/client';
import type { InboxModules } from './approvals-inbox';

/** Coalesce only simultaneous mobile display reads with the complete verified context.
 * No completed response is retained. Decision readers never use this coordinator.
 */
export function createMobileTaskReadFlights<T>(capacity = 32, now = () => performance.now(), joinWindowMs = 2000) {
  const flights = new Map<string, {promise:Promise<T>; started:number}>();
  return {
    read(ctx: SessionContext, modules: InboxModules, load: () => Promise<T>): Promise<T> {
      let key: string;
      try { key = JSON.stringify([ctx, modules]); }
      catch { return Promise.resolve().then(load); }
      if (key.length > 65536) return Promise.resolve().then(load);
      const existing = flights.get(key);
      if (existing && now()-existing.started <= joinWindowMs) return existing.promise;
      if (existing) flights.delete(key);
      // Saturation changes only reuse, never authorization or availability.
      if (flights.size >= capacity) return Promise.resolve().then(load);
      const pending = Promise.resolve().then(load);
      flights.set(key, {promise:pending,started:now()});
      const clear = () => { if (flights.get(key)?.promise === pending) flights.delete(key); };
      void pending.then(clear, clear);
      return pending;
    },
  };
}
