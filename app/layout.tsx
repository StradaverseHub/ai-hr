import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Geist_Mono } from 'next/font/google';
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
import { LogoutButton } from '@/components/logout-button';
import { CompanySwitcher } from '@/components/company-switcher';
import { TourLauncher } from '@/components/tour-launcher';
import { OnboardingTour } from '@/components/onboarding-tour';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { isAuthRoute as isAuthRoutePath } from '@/lib/auth-routes';
import { canManagePayroll, canManagePerfComp, isAdmin } from '@/lib/authz';
import { listPrincipals } from '@/lib/principals';
import { demoSwitcherEnabled } from '@/lib/demo-mode';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import { getOnboardingStatus } from '@/core/onboarding';
import { pendingApprovalsCount } from '@/core/approvals-inbox';
import { NotificationBell } from '@/components/notification-bell';
import { NotificationCenter } from '@/components/notification-center';
import { CommandBar } from '@/components/command-bar';
import { dispatchNotifications, listNotifications, unreadNotificationCount } from '@/core/notifications';
import { listApprovalHistory } from '@/core/read';
import { shapeApprovalHistoryItems } from '@/lib/approval-history';
import { toursForRoles, WELCOME_TOUR_ID } from '@/lib/onboarding-tour';

const jakarta = Plus_Jakarta_Sans({ variable: '--font-jakarta', subsets: ['latin'], display: 'swap' });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'AI HR',
  description: 'AI-native HR platform',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Auth routes (ADR-0072) render WITHOUT the app shell and WITHOUT the getSession gate — otherwise
  // the redirect-to-/login would loop on /login itself. The prefix list lives in lib/auth-routes.ts
  // because middleware.ts needs the same list; keeping two copies is what let them drift apart.
  const pathname = (await headers()).get('x-pathname') ?? '';
  const isAuthRoute = isAuthRoutePath(pathname);
  const locale = await getLocale();

  if (isAuthRoute) {
    // Bare shell for the login flow: fonts + theme + intl, no sidebar / topbar / session.
    return (
      <html
        lang={locale}
        className={`${jakarta.variable} ${geistMono.variable} h-full antialiased`}
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
  const onboarded = await getOnboardingStatus(session);
  const tours = toursForRoles(session.roles);
  // Notification bell shows the approvals queue — only managers/admins have one.
  const canApprove = isAdmin(session) || (session.roles ?? []).includes('manager');
  const pendingApprovals = canApprove ? await pendingApprovalsCount(session, scopeIds) : 0;
  // ADR-0034 34-3: when notifications are on, the bell shows the viewer's own notifications (everyone), not
  // just the approvals queue. Opportunistic catch-up — an admin loading any page dispatches the tenant's new
  // events (a cron is the production path, 34-4); non-admins can't dispatch (RLS), they read what exists.
  const notifEnabled = process.env.NOTIFICATIONS_ENABLED === 'true';
  if (notifEnabled && isAdmin(session)) await dispatchNotifications(session).catch(() => {});
  const notifUnread = notifEnabled ? await unreadNotificationCount(session) : 0;
  const notifItems = notifEnabled ? await listNotifications(session, undefined, { limit: 12 }) : [];
  // Approval history tab (44a89810): recent team decisions for the bell's History tab. Fetched ONLY when
  // the bell is on AND the viewer can approve — no dead query for regular employees or in flag-off mode.
  const approvalHistory =
    notifEnabled && canApprove
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
      className={`${jakarta.variable} ${geistMono.variable} h-full antialiased`}
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
              defaultCollapsed={railCollapsed}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-3 lg:gap-4">
              {/* Three-zone grid: equal minmax(0,1fr) side tracks keep the centre search geometrically
                  centred regardless of what each cluster contains (dev switcher hidden in production,
                  bell variants, …). The centre track is minmax(0,28rem) on sm+ so the w-full trigger has
                  a real track to fill — a bare `auto` track would size to content and never widen it. */}
              <header className="grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 rounded-[1.25rem] border border-border bg-card px-4 shadow-[var(--shadow-card)] sm:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]">
                <div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground/80">Demo Group</span>
                  {showDevSwitcher && (
                    <>
                      <span
                        className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
                        title="Dev session"
                      >
                        dev
                      </span>
                      <DevIdentitySwitcher principals={principals} current={session.userId ?? ''} />
                    </>
                  )}
                </div>
                <div className="flex min-w-0 items-center justify-center">
                  <CommandBar />
                </div>
                <div className="flex min-w-0 items-center justify-end gap-2.5">
                  <CompanySwitcher companies={allowed} selected={scopeIds} />
                  <div className="h-5 w-px bg-border" />
                  {notifEnabled ? (
                    <NotificationCenter
                      unread={notifUnread}
                      items={notifItems}
                      history={approvalHistory}
                      canApprove={canApprove}
                    />
                  ) : (
                    canApprove && <NotificationBell count={pendingApprovals} />
                  )}
                  <span data-tour="language">
                    <LanguageSwitcher />
                  </span>
                  <span data-tour="theme">
                    <ThemeToggle />
                  </span>
                  <TourLauncher />
                  <LogoutButton />
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
