/**
 * D8 — "the roster or the clock may have changed, re-plan the shift reminders". Dependency-free, so a screen that
 * shows the roster or records a punch can raise it without pulling notifications into its own module. mobile/lib/push.tsx
 * listens (and coalesces bursts); nothing else does. Carries no data.
 */
const listeners = new Set<() => void>();
export function requestShiftReminderRefresh(): void { for (const listener of [...listeners]) { try { listener(); } catch { /* a listener's failure is its own */ } } }
export function onShiftReminderRefresh(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
