import type { ClockResponse } from './api';
/**
 * D8 — "the roster or the clock may have changed, re-plan the shift reminders". Dependency-free, so a screen that
 * shows the roster or records a punch can raise it without pulling notifications into its own module. mobile/lib/push.tsx
 * listens (and coalesces bursts). A fresh own-clock response may also update the widget
 * without another network read; it is transient and carries its full ownership scope.
 */
export type ShiftReminderRefresh = {clock?:{value:ClockResponse;namespace:string;generation:number;employmentId:string|null}};
const listeners = new Set<(event?:ShiftReminderRefresh) => void>();
export function requestShiftReminderRefresh(event?:ShiftReminderRefresh): void { for (const listener of [...listeners]) { try { listener(event); } catch { /* a listener's failure is its own */ } } }
export function onShiftReminderRefresh(listener: (event?:ShiftReminderRefresh) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
