import { NextRequest } from 'next/server';

/**
 * AuthKit derives callback destinations and Secure cookie flags from request.url. A self-hosted Next
 * server may report its HTTP loopback listener there, so give the SDK the configured public origin.
 * Never infer that origin from client-controlled Host/forwarded headers.
 *
 * This is only a URL/header view for AuthKit: it is not forwarded to the route and does not copy or
 * consume the original POST body. AuthKit session handling reads cookies, URL and method only.
 */
export function workosRequest(request: NextRequest): NextRequest {
  let callback: URL;
  try {
    callback = new URL(process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? '');
    if (callback.protocol !== 'https:' || callback.username || callback.password ||
      callback.pathname !== '/callback' || callback.search || callback.hash) throw new Error();
  } catch {
    throw new Error('WorkOS requires a configured HTTPS /callback URI.');
  }
  const publicUrl = new URL(callback.origin);
  publicUrl.pathname = request.nextUrl.pathname;
  publicUrl.search = request.nextUrl.search;
  return new NextRequest(publicUrl, { method: request.method, headers: request.headers });
}
