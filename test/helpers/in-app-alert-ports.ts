import type { ReactNode } from 'react';

/** Form suites inspect confirmation intent; real Android rendering/ownership is covered by mobile-in-app-alert tests. */
export function inAppAlertPorts(native: unknown) {
  const alert = (native as { Alert?: unknown } | undefined)?.Alert;
  return {
    InAppAlert: alert ?? { alert() { throw new Error('Missing confirmation-intent port'); } },
    InAppAlertBoundary: ({ children }: { children: ReactNode }) => children,
  };
}
