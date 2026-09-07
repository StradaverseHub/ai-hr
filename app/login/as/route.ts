import { NextResponse, type NextRequest } from 'next/server';
import { demoSwitcherEnabled } from '@/lib/demo-mode';
import { listPrincipals } from '@/lib/principals';

/**
 * Sign in as a seeded demo identity — a ROUTE HANDLER, not a server action, and that is the whole point.
 *
 * ═══ WHY NOT A SERVER ACTION (this was a real, shipped bug) ═══
 *
 * The first version of /login used a server action that did `cookies().set('dev_user', …)` then
 * `redirect('/')`. MEASURED ON PRODUCTION: the cookie was set correctly every time — it was in the jar,
 * and curling `/` with that exact cookie returned 200 for every identity — but the navigation the action
 * itself performed arrived at the server WITHOUT it, so the layout saw a signed-out request and bounced
 * to /login. A plain reload straight afterwards worked perfectly and landed the right person in the app
 * with the right access. So the identity was fine; only the post-action navigation was broken.
 *
 * A route handler removes the race instead of papering over it. The browser POSTs, gets a 303 whose
 * `Set-Cookie` it stores before it follows the `Location`, and the subsequent GET / carries the cookie
 * like any other request. One ordinary HTTP round trip, no RSC cookie timing to reason about.
 *
 * ═══ THE ID IS VALIDATED, NOT TRUSTED ═══
 *
 * `dev_user` selects the principal the whole app runs as, so this endpoint must never write an arbitrary
 * value from a form post. The id has to be one `listPrincipals()` actually offers — the same list the page
 * renders — and outside dev/the demo the endpoint does not exist at all.
 *
 * Choosing an identity is SELECTION, not authentication: there is no password, and the security boundary
 * remains the SHARE_PASSWORD gate in middleware.ts. See app/login/page.tsx.
 */
export async function POST(req: NextRequest) {
  // 404 rather than 403 in a real deployment: the endpoint genuinely does not exist there, and saying so
  // is better than implying a demo-only door is merely closed.
  if (!demoSwitcherEnabled()) return new NextResponse('Not found', { status: 404 });

  const form = await req.formData();
  const userId = String(form.get('userId') ?? '');

  const allowed = await listPrincipals();
  if (!allowed.some((p) => p.userId === userId)) {
    // An id nobody is offered — a stale form, or a hand-crafted post. Back to the chooser, no cookie set.
    return seeOther('/login');
  }

  const res = seeOther('/');
  res.cookies.set('dev_user', userId, { httpOnly: true, sameSite: 'lax', path: '/' });
  return res;
}

/**
 * ⚠️ A RELATIVE `Location`, AND THIS IS NOT A STYLE CHOICE — THE ABSOLUTE FORM SHIPPED BROKEN.
 *
 * The first version used Next's redirect helper with a URL built from the incoming request's own address.
 * That address is the server's INTERNAL origin (`http://127.0.0.1:3000/...`) because the app sits behind a
 * tunnel, so the browser was told to navigate somewhere it cannot reach and landed on a blank
 * 39-character document — measured: the same page fetched directly rendered fine with 11 nav entries.
 * Anyone reaching the demo through cloudflared would have hit exactly that.
 *
 * ⚠️ The guard in test/demo-login-flow.test.ts scans this file as TEXT and does not strip comments
 * (AGENTS 27), so the two forbidden expressions are described here rather than spelled out. Naming them
 * literally would fail the very check that keeps this fixed.
 *
 * A relative Location is valid (RFC 7231 §7.1.2) and the browser resolves it against the URL IT used, so
 * the public origin is preserved without this route having to know what that origin is. Any future
 * redirect from a route handler here should do the same.
 *
 * 303, not 302: the POST must become a GET on the way to the destination.
 */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}
