import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Geist_Mono, Schibsted_Grotesk, DM_Mono } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import './globals.css';
import { Suspense } from 'react';
import { Providers } from './providers';
import { Sidebar } from '@/components/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { LanguageSwitcher } from '@/components/language-switcher';
import { Toaster } from '@/components/ui/sonner';
import { ToastFromQuery } from '@/components/ui/toast-trigger';
import { DevIdentitySwitcher } from '@/components/dev-identity-switcher';
import { UserMenu } from '@/components/user-menu';
import { CompanySwitcher } from '@/components/company-switcher';
import { OnboardingTour } from '@/components/onboarding-tour';
import { NoticePopupSlot } from '@/components/notice/notice-surfaces';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { viewerIdentity } from '@/lib/viewer';
import { visibleModuleCodes } from '@/lib/nav-entitlements';
import { AuthRequiredError } from '@/lib/auth-errors';
import { isAuthRoute as isAuthRoutePath } from '@/lib/auth-routes';
import { canManagePayroll, canManagePerfComp, hasTeamAccess, isAdmin } from '@/lib/authz';
import { listPrincipals } from '@/lib/principals';
import { demoSwitcherEnabled, isDemoDeployment } from '@/lib/demo-mode';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import { getOnboardingStatus } from '@/core/onboarding';
import { listPendingTasks } from '@/core/approvals-inbox';
import { NotificationCenter } from '@/components/notification-center';
import { CommandBar } from '@/components/command-bar';
import { dispatchNotifications, listNotifications, unreadNotificationCount } from '@/core/notifications';
import { listApprovalHistory } from '@/core/read';
import { shapeApprovalHistoryItems } from '@/lib/approval-history';
import { toursForRoles, WELCOME_TOUR_ID } from '@/lib/onboarding-tour';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { UI_THEME_COOKIE, resolveUiTheme } from '@/lib/ui-theme';

// r396: Classic's faces are no longer the default, so they are not preloaded on every page (they still load,
// on demand, for a Classic user). Monolith's two faces preload.
const jakarta = Plus_Jakarta_Sans({ variable: '--font-jakarta', subsets: ['latin'], display: 'swap', preload: false });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'], preload: false });
// r396 — Monolith's faces (docs/design/monolith/README.md §2), loaded BESIDE Classic's. Both sets of
// variables are always on <html>; app/globals.css maps --font-jakarta / --font-geist-mono onto these two
// only under `:root[data-ui-theme="monolith"]`, so Classic keeps Jakarta + Geist Mono untouched and the
// CJK / Thai / Tamil fallback chain in --font-sans is shared by both themes.
const schibsted = Schibsted_Grotesk({
  variable: '--font-schibsted',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});
const dmMono = DM_Mono({ variable: '--font-dm-mono', subsets: ['latin'], weight: ['400', '500'] });
const fontVariables = `${jakarta.variable} ${geistMono.variable} ${schibsted.variable} ${dmMono.variable}`;

// A literal, not common.appName: `metadata` is evaluated outside the request/locale scope, so there is
// no translator here. The brand name is the same string in all six locales anyway — it is a name, not
// copy — so the sidebar reading it from `common.appName` and this reading it from source stay in step.
export const metadata: Metadata = {
  title: 'Kingdee AI HR',
  description: 'AI-native HR platform',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Auth routes (ADR-0072) render WITHOUT the app shell and WITHOUT the getSession gate — otherwise
  // the redirect-to-/login would loop on /login itself. The prefix list lives in lib/auth-routes.ts
  // because middleware.ts needs the same list; keeping two copies is what let them drift apart.
  const pathname = (await headers()).get('x-pathname') ?? '';
  const isAuthRoute = isAuthRoutePath(pathname);
  const locale = await getLocale();
  // r396 — the UI theme, from the `ui_theme` cookie, written onto <html> so the FIRST paint is already in
  // the chosen theme (no flash). Absent or unknown → Monolith (lib/ui-theme.ts). Read before the auth
  // branch so /login is themed too. Light/dark is a separate axis (next-themes' `.dark` class).
  const uiTheme = resolveUiTheme((await cookies()).get(UI_THEME_COOKIE)?.value);

  if (isAuthRoute) {
    // Bare shell for the login flow: fonts + theme + intl, no sidebar / topbar / session.
    return (
      <html
        lang={locale}
        data-ui-theme={uiTheme}
        className={`${fontVariables} h-full antialiased`}
        suppressHydrationWarning
      >
        <body className="h-dvh overflow-auto bg-canvas font-sans">
          <NextIntlClientProvider>
            <Providers>{children}</Providers>
          </NextIntlClientProvider>
        </body>
      </html>
    );
  }

  // ADR-0072: resolve the session; an unauthenticated / offboarded principal (AuthRequiredError from
  // the WorkOS path) redirects to /login rather than 500-ing the whole app.
  let session;
  try {
    session = await getSession();
  } catch (e) {
    if (e instanceof AuthRequiredError) redirect('/login');
    throw e;
  }
  const principals = await listPrincipals();
  // Dev identity switcher: developers, plus the gated consultant demo (ALLOW_DEMO_SESSION; see lib/demo-mode).
  const showDevSwitcher = demoSwitcherEnabled();
  const allowed = await allowedCompanies(session);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  const cookieStore = await cookies();
  const railCollapsed = cookieStore.get('rail_collapsed')?.value === '1';
  // fdc20776: the per-group nav_*_open cookies are gone — flyout panels are show-on-demand, so
  // there is no open/closed state to persist (stale cookies in existing browsers are unused and
  // harmless). rail_collapsed handling is unchanged.
  // fbf6abd0 — WHO IS SIGNED IN. The name + Employee ID shown in the top right, read from the viewer's
  // own EMPLOYMENT and PERSON (lib/viewer.ts), never from lib/principals.ts: that list is the dev/demo
  // switcher and is empty on a real deployment, which is exactly why the header used to carry no
  // identity at all. It always resolves to something renderable — an employed viewer, a named principal
  // with no employment (an admin never hired, or a leaver), or a login attached to no person at all.
  // Memoised, so the NoticePopupSlot below shares the employment row rather than re-reading it.
  const viewer = await viewerIdentity(session);
  const onboarded = await getOnboardingStatus(session);
  const tours = toursForRoles(session.roles);
  const canApprove = isAdmin(session) || (session.roles ?? []).includes('manager');
  // ADR-0034 34-3: when notifications are on, the bell shows the viewer's own notifications (everyone), not
  // just the approvals queue. Opportunistic catch-up — an admin loading any page dispatches the tenant's new
  // events (a cron is the production path, 34-4); non-admins can't dispatch (RLS), they read what exists.
  // `…OrFalse`, not `isModuleEnabled`: this is the ROOT layout, so a throw here 500s every
  // authenticated route — and lib/session.ts deliberately degrades a snapshot-resolution failure into
  // `entitlementsError` on the session precisely so the app stays navigable. See the helper: it
  // swallows ONLY EntitlementsResolutionFailedError (the infrastructure state), and still throws for a
  // malformed or mis-attributed context, which is a wiring bug and must stay loud.
  const notifEnabled = isModuleEnabledOrFalse(session, 'notifications');
  if (notifEnabled && isAdmin(session)) await dispatchNotifications(session).catch(() => {});
  // 3-tab bell (feedback 1514d366) — one notification framework for every role, role-scoped by the reads:
  //   • Notification tab: unread informational (non-action) notifications + their unread badge.
  //   • Task tab: the live approvals queue (listPendingTasks — replaces the retired count-only legacy
  //     bell; self-short-circuits to [] for plain employees) + unread severity-'action' notifications.
  //   • History tab: read notifications + recent approval decisions (canApprove only) — never counted.
  // r292 — the two optional-module queues inside the inbox. Resolved HERE, with the quiet form, for the
  // same reason `notifEnabled` two lines above uses it: this is the root layout and a throw 500s every
  // authenticated route. `listPendingTasks` takes the answer rather than asking, so the loud/quiet choice
  // belongs to whichever surface calls it.
  const pendingTasks = await listPendingTasks(session, scopeIds, {
    attendance: isModuleEnabledOrFalse(session, 'attendance'),
    claims: isModuleEnabledOrFalse(session, 'claims'),
  });
  const notifUnread = notifEnabled ? await unreadNotificationCount(session, undefined, { action: false }) : 0;
  const taskNotifCount = notifEnabled ? await unreadNotificationCount(session, undefined, { action: true }) : 0;
  const notifItems = notifEnabled ? await listNotifications(session, undefined, { limit: 12, read: false, action: false }) : [];
  const taskNotifs = notifEnabled ? await listNotifications(session, undefined, { limit: 12, read: false, action: true }) : [];
  const readNotifs = notifEnabled ? await listNotifications(session, undefined, { limit: 12, read: true }) : [];
  // Approval history (44a89810): recent team decisions for the bell's History tab — canApprove only,
  // no dead query for regular employees.
  const approvalHistory = canApprove
    ? shapeApprovalHistoryItems(
        await listApprovalHistory(session, {
          from: new Date(Date.now() - 90 * 86400000).toISOString(),
          limit: 10,
        }),
      )
    : [];
  return (
    <html
      lang={locale}
      data-ui-theme={uiTheme}
      className={`${fontVariables} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-dvh overflow-hidden bg-canvas p-3 font-sans lg:p-4">
        <NextIntlClientProvider>
        <Providers>
          {/* Detached floating layout: the rail, the top bar, and each content card
              float separately on the canvas with gutters between them. */}
          <div className="flex h-full gap-3 lg:gap-4">
            <Sidebar
              // ADR-0049: a partner is an admin who sees a subset, so it gets the admin nav group;
              // each page's route guard (requirePayrollAccess / requirePerfCompAccess) 403/redirects
              // the pages it can't enter. The cap ORs isAdmin into every partner capability so a user
              // who is BOTH hr_admin and a partner is never narrower than a plain admin (union rule).
              isAdmin={isAdmin(session) || canManagePayroll(session) || canManagePerfComp(session)}
              canApprove={(session.roles ?? []).includes('manager')}
              canAccessTeam={hasTeamAccess(session)}
              // Pending-approval badge on the "Approval Items" row (feedback 836118c4). Reuses the
              // pendingTasks already resolved above for the bell — ZERO extra queries — so the badge is
              // by construction the same user-scoped queue: only items awaiting THIS viewer's decision,
              // self-excluding, admin-only categories gated inside listPendingTasks. NOT the bell's
              // taskCount below, which also folds in unread action notifications (not approval records).
              approvalCount={pendingTasks.length}
              // ADR-0077 slice 4 — which module-owned rows the rail may advertise. A plain string array
              // (or null), never the snapshot itself: Sidebar is a client component, and passing the
              // entitlement context would drag the resolver into the client bundle. null means "no
              // opinion, show everything" and is what a degraded session produces on purpose — see
              // lib/nav-entitlements.ts for why nav fails OPEN while every service gate fails closed.
              enabledModules={visibleModuleCodes(session)}
              defaultCollapsed={railCollapsed}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-3 lg:gap-4">
              {/* Three-zone grid: equal minmax(0,1fr) side tracks keep the centre search geometrically
                  centred regardless of what each cluster contains (dev switcher hidden in production,
                  bell variants, …). The centre track is bounded from sm up so the w-full trigger has a
                  real track to fill — a bare `auto` track would size to content and never widen it.

                  ⚠️ THE CENTRE TRACK'S MAX IS A BUDGET TAKEN FROM BOTH SIDE TRACKS, and r256 measured
                  what that cost. The shell is body p-4 + a 232px rail + gap-4, so the header is
                  `viewport − 280`: 1000px at 1280, 1160px at 1440. A 28rem centre left each side track
                  243px / 323px, and the account corner's name and Employee ID rendered at ZERO width on
                  both — the identification this header exists to carry was invisible on exactly the
                  laptop sizes most people use. 20rem below 2xl hands each side track +64px (the search
                  TRIGGER is an icon + a placeholder + a ⌘K hint, nowhere near 448px of content); 28rem
                  returns at 2xl, where there is room for both. Measured in a real engine at 1280 and
                  1440 by test/topbar-identity-width.browser.test.tsx — change these numbers and that
                  test re-measures them.

                  ⚠️⚠️ r374 — AND BELOW 1024 THAT BUDGET WAS BIGGER THAN THE HEADER, which is where the
                  reported sideways scrolling came from. A FIXED `minmax(0,20rem)` centre is taken FIRST,
                  before the fr side tracks get anything, so from the sm breakpoint (where the 232px rail
                  appears and the header gets 232px NARROWER while the centre gets 278px WIDER) the side
                  tracks collapsed: measured on the dev server at an 820px viewport, header 552px, side
                  tracks 83px each. The right cluster cannot shrink below 206px (1px divider + 3 × 36px
                  icon buttons + 4 × 8px gaps + the account trigger's irreducible avatar + chevron +
                  padding = 65px), so the account control was handed a 0-width box and its shrink-0
                  avatar and chevron spilled out of it to the RIGHT: documentElement.scrollWidth 856 vs
                  clientWidth 820, and window.scrollTo(500,0) moved the canvas 36px. Identical on all 13
                  routes measured, i.e. the shell, and identical with the dev chrome removed, i.e. it
                  shipped. (Not a visible scrollbar — body's overflow-hidden propagates to the viewport —
                  but a programmatic one, which is exactly the "page is cut off" shape of
                  test/layout-scroll-containment.ts.)

                  SO THE CENTRE NOW YIELDS INSTEAD OF THE SIDES: `min(20rem, 100% − 27.75rem)`. 27.75rem
                  is 444px = 2 × the 206px cluster floor + the two 16px grid gaps — the width the centre
                  must leave alone before it takes anything for itself. `100%` resolves against the
                  header's content box, so this is self-balancing and needs no breakpoint per viewport:
                  the centre gets 74px at 820, 266px at 1024, the full 320px from ~1090 up, and 1120 /
                  1280 / 1440 / 1512 / 1600 / 1920 are byte-identical to before the change (307/320/307
                  at 1280 — the r256 budget is untouched).

                  AND BELOW md THE SIDES STOP BEING EQUAL. Two 206px side tracks plus two gaps need a
                  444px header, i.e. a 776px viewport with the rail out; below that no centre width at
                  all can make equal tracks fit. So from 0 to 767 the right track is `minmax(0,max-content)`
                  — it is served before the left one, which is the compressible side (a static group
                  label and a switcher that already truncates) — and the search is no longer centred
                  there. Nothing was centred there before either: the left cluster was overflowing its
                  own track. From md up the equal tracks and the exact centring return (measured: the
                  centre's midpoint is 0px off the header's midpoint at every width ≥ 768). */}
              <header className="grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,max-content)] items-center gap-4 rounded-[1.25rem] border border-border bg-card px-4 shadow-[var(--shadow-card)] sm:grid-cols-[minmax(0,1fr)_minmax(0,min(20rem,max(0px,100%_-_27.75rem)))_minmax(0,max-content)] md:grid-cols-[minmax(0,1fr)_minmax(0,min(20rem,max(0px,100%_-_27.75rem)))_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,min(28rem,max(0px,100%_-_27.75rem)))_minmax(0,1fr)]">
                {/* Left cluster = WHERE you are working. The CompanySwitcher MOVED here from the right
                    cluster (r256): this track is a full 1fr — 243px at 1280, 563px at 1920 — carrying
                    one static group label, while the switcher was being crushed to 27px on the right
                    (its label gone entirely at 1280) by six other controls. Group name and company
                    scope are the same question and now sit together; the right cluster is now only
                    "you". `Demo Group` is shrink-0 so the switcher stays the one compressible child
                    here, exactly as it was on the right. */}
                <div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
                  <span className="shrink-0 font-medium text-foreground/80">Demo Group</span>
                  <CompanySwitcher companies={allowed} selected={scopeIds} />
                  {showDevSwitcher && (
                    <>
                      <span
                        className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
                        title="Dev session"
                      >
                        dev
                      </span>
                      {/* ⚠️ NOT ON THE GATED DEMO. The demo now signs a tester in at /login as a chosen
                          identity so they can experience the product with exactly that person's access;
                          a header control that swaps identity mid-session defeats that — you would stop
                          testing an access level and start browsing with all of them. Local `pnpm dev`
                          keeps it, where switching quickly between roles is the point. */}
                      {!isDemoDeployment() && (
                        <DevIdentitySwitcher principals={principals} current={session.userId ?? ''} />
                      )}
                    </>
                  )}
                </div>
                <div className="flex min-w-0 items-center justify-center">
                  <CommandBar />
                </div>
                {/* Right cluster (overlap guard d9b81f8d): min-w-0 lets the 1fr track constrain the
                    cluster, and every child must stay shrink-capable or fixed-size — the UserMenu is
                    the one compressible child left (min-w-0 + truncate in its component); a
                    non-shrinkable child re-introduces the leftward spill over the centre search
                    track that justify-end produces on overflow. The divider drops below md so
                    less-important chrome trims before anything collides.

                    ⚠️ THIS CLUSTER IS A FIXED BUDGET AND IT IS FULL. Measured at a 1280 viewport: the
                    track is 307px, the divider + three 36px icon buttons + four 8px gaps take 141px,
                    and the account trigger gets the remaining 166 — against the 161 it needs to show
                    "Aisyah Rahman" over "EMP-0001". FIVE PIXELS. Two controls had to leave in r256 to
                    buy even that (CompanySwitcher to the left cluster, TourLauncher into the account
                    menu) and the centre track gave back 64px. ADDING A CONTROL HERE TAKES THE NAME
                    AWAY AGAIN, and does it SILENTLY: the cluster does not overflow, the name truncates
                    to nothing. test/topbar-overlap-guard.test.ts pins this child list — it fails on a
                    new control rather than letting one land unmeasured — and
                    test/topbar-identity-width.browser.test.tsx re-measures the result at 1280/1440. */}
                <div className="flex min-w-0 items-center justify-end gap-2 2xl:gap-2.5">
                  <div className="hidden h-5 w-px shrink-0 bg-border md:block" />
                  {/* 3-tab bell for EVERY role (1514d366). The legacy count-only bell is retired — the
                      Task tab covers its purpose (and works even with NOTIFICATIONS_ENABLED off, where
                      only the notification reads are dark). */}
                  <NotificationCenter
                    unread={notifUnread}
                    items={notifItems}
                    tasks={pendingTasks}
                    taskNotifications={taskNotifs}
                    taskCount={pendingTasks.length + taskNotifCount}
                    readItems={readNotifs}
                    history={approvalHistory}
                    canApprove={canApprove}
                  />
                  <span data-tour="language">
                    <LanguageSwitcher />
                  </span>
                  <span data-tour="theme">
                    <ThemeToggle />
                  </span>
                  {/* Log out and "Take a tour" live INSIDE this menu now (fbf6abd0, r256). Each is one
                      extra click, and together they are what buys the corner room to say who you are on
                      a 1280px laptop. The tour launcher was also the control the cluster was already
                      squeezing: measured at 20px wide instead of 36, its icon clipped. */}
                  <UserMenu name={viewer.name} employeeCode={viewer.employeeCode} employed={viewer.employed} />
                </div>
              </header>
              {/* `relative` is load-bearing: sr-only helpers are position:absolute, and with no
                  positioned ancestor they escape main's scroll clipping and pile up scrollable
                  overflow on <html> itself. body's overflow-hidden propagates to the viewport, which
                  still allows PROGRAMMATIC scrolling — so any focus/scrollIntoView deep in a long
                  page shifted the whole canvas (header + sidebar off-screen) with no wheel recovery.
                  Making main the containing block keeps that overflow inside the scroller. */}
              <main className="relative min-w-0 flex-1 overflow-y-auto pb-1">{children}</main>
            </div>
          </div>
          <OnboardingTour tours={tours} autoStartTourId={onboarded ? null : WELCOME_TOUR_ID} />
          {/* 6e122302 — the after-login notice popup, mounted beside the onboarding tour because that is
              the existing "show something once after login and remember the dismissal" surface. At most
              ONE notice, chosen server-side; the slot renders null when nothing is due, so this costs an
              already-cached employment lookup and nothing else on the overwhelming majority of loads. */}
          <NoticePopupSlot s={session} />
          <Suspense fallback={null}>
            <ToastFromQuery />
          </Suspense>
          <Toaster />
        </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
