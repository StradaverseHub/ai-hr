/**
 * Client-side helpers for the per-browser clocking-device token (feedback 5249d43f).
 *
 * The token is minted SERVER-side at registration (core/attendance-device.ts registerDevice) and handed to
 * the browser exactly once; this module owns where it lives on the client (localStorage) so the /me clock
 * card and the Attendance > Clock in/out page read/write the SAME key. Deliberately db-free (no server
 * imports) — safe inside any 'use client' island.
 *
 * localStorage access is try/caught throughout: private-mode/embedded browsers can throw on ANY touch, and
 * a storage failure must degrade to "no token" (the server then decides whether that blocks the punch).
 */
export const DEVICE_TOKEN_STORAGE_KEY = 'ai-hr.clock-device-token';

export function getStoredDeviceToken(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeDeviceToken(token: string): void {
  try {
    window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage unavailable — the registration still exists server-side; the next punch will simply carry no
    // token and the server will re-prompt for registration where required.
  }
}

/** A human-friendly default device name from the user agent (e.g. "Chrome on macOS"), pre-filled into the
 *  registration form and freely editable by the employee. Best-effort string sniffing — never load-bearing. */
export function suggestDeviceLabel(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('firefox/')
      ? 'Firefox'
      : ua.includes('chrome/') || ua.includes('crios/')
        ? 'Chrome'
        : ua.includes('safari/')
          ? 'Safari'
          : 'Browser';
  const os = ua.includes('iphone')
    ? 'iPhone'
    : ua.includes('ipad')
      ? 'iPad'
      : ua.includes('android')
        ? 'Android'
        : ua.includes('mac os')
          ? 'macOS'
          : ua.includes('windows')
            ? 'Windows'
            : ua.includes('linux')
              ? 'Linux'
              : 'device';
  return `${browser} on ${os}`;
}
