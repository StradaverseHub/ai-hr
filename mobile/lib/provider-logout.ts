/** WorkOS's documented logout uses a session id, never an access/refresh token in the URL. */
export function sessionIdFromToken(token: string): string | null {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')));
    return typeof json.sid === 'string' && json.sid.length > 0 ? json.sid : null;
  } catch { return null; }
}
export function providerLogoutUrl(sessionId: string | null, returnTo?: string): string | null {
  if (!sessionId) return null;
  return `https://api.workos.com/user_management/sessions/logout?session_id=${encodeURIComponent(sessionId)}${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ''}`;
}
