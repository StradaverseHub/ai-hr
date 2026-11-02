'use client';
import { useEffect } from 'react';

/** Moves focus to an element that just appeared in place, without scrolling the page (the Inbox recommendation
 * panel opens under its own row; a screen reader user lands on it, a sighted user's view stays put). */
export function FocusOnMount({ targetId }: { targetId: string }) {
  useEffect(() => { document.getElementById(targetId)?.focus({ preventScroll: true }); }, [targetId]);
  return null;
}
