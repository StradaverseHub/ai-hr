'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { registerUnsavedGuard } from '@/lib/unsaved-changes';

/**
 * 82748f92 — lets a formless editor (client-state grid with no named form fields) take part in the page's
 * unsaved-changes check. While `hasChanges` is true, lib/unsaved-changes.ts reports it dirty, so the People ›
 * Settings guard (components/people-settings-navigation.tsx) asks before leaving. The ref is updated in a layout effect
 * so the guard sees the edit as soon as the DOM reflects it. Cancel keeps the edits; nothing is ever saved.
 */
export function useRegisteredUnsavedChanges(hasChanges: boolean, message: string) {
  const state = useRef({ hasChanges, message });
  // Layout effect: committed before any MutationObserver/microtask reads it, so the guard sees the edit at once.
  useLayoutEffect(() => { state.current = { hasChanges, message }; });
  useEffect(() => registerUnsavedGuard({
    isDirty: () => state.current.hasChanges,
    prompt: (proceed) => { if (window.confirm(state.current.message)) proceed(); },
  }), []);
}
