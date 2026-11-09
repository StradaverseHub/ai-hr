import type { ReactNode } from 'react';

/** Form suites inspect confirmation intent; real Android rendering/ownership is covered by mobile-in-app-alert tests. */
export function inAppAlertPorts(native: unknown) {
  const alert = (native as { Alert?: { alert: (...args: unknown[]) => void } } | undefined)?.Alert;
  const show = alert?.alert ?? (() => { throw new Error('Missing confirmation-intent port'); });
  return {
    InAppAlert: { alert: show, approval: show },
    InAppAlertBoundary: ({ children }: { children: ReactNode }) => children,
  };
}
