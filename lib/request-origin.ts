/**
 * Compare the browser origin with this HTTP request's public authority. Next's URL can contain its
 * internal listener hostname behind a reverse proxy. Host still addresses the actual application;
 * an arbitrary forwarded-host value must never become an alternate origin allow-list.
 */
export function isSameOriginBrowserRequest(request: Request): boolean {
  const raw = request.headers.get('origin');
  if (!raw) return false;
  try {
    const origin = new URL(raw);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== raw) return false;
    const internal = new URL(request.url);
    if (origin.protocol !== internal.protocol) return false;
    const authority = request.headers.get('host');
    if (authority == null) return origin.origin === internal.origin;
    // Reject ambiguous lists, user-info, paths and URL separators rather than normalizing them away.
    if (!authority || /[\s,/@\\?#]/.test(authority)) return false;
    const addressed = new URL(`${internal.protocol}//${authority}`);
    return addressed.origin === origin.origin;
  } catch {
    return false;
  }
}
