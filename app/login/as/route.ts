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
    return NextResponse.redirect(new URL('/login', req.url), { status: 303 });
  }

  // 303, not 302: the POST must become a GET on the way to the dashboard.
  const res = NextResponse.redirect(new URL('/', req.url), { status: 303 });
  res.cookies.set('dev_user', userId, { httpOnly: true, sameSite: 'lax', path: '/' });
  return res;
}
