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
import { toursForRoles, WELCOME_TOUR_ID } from '@/lib/onboarding-tour';

const jakarta = Plus_Jakarta_Sans({ variable: '--font-jakarta', subsets: ['latin'], display: 'swap' });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'AI HR',
  description: 'AI-native HR platform',
};

// Auth routes (ADR-0072): rendered WITHOUT the authenticated app shell and WITHOUT the getSession
// gate — otherwise the layout's redirect-to-/login would loop on /login itself.
const AUTH_ROUTE_PREFIXES = ['/login', '/callback', '/invite', '/reset-password'];

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = (await headers()).get('x-pathname') ?? '';
  const isAuthRoute = AUTH_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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
  // Per-group open state for collapsible nav sections (b3dc0f78); read SSR-side to avoid a flash.
  const openGroups = {
    nav_attendance_open: cookieStore.get('nav_attendance_open')?.value === '1',
    nav_reports_open: cookieStore.get('nav_reports_open')?.value === '1',
  };
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
              openGroups={openGroups}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-3 lg:gap-4">
              <header className="flex h-16 shrink-0 items-center justify-between gap-4 rounded-[1.25rem] border border-border bg-card px-4 shadow-[var(--shadow-card)]">
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
                <div className="flex items-center gap-2.5">
                  <CommandBar />
                  <CompanySwitcher companies={allowed} selected={scopeIds} />
                  <div className="h-5 w-px bg-border" />
                  {notifEnabled ? (
                    <NotificationCenter unread={notifUnread} items={notifItems} />
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
              <main className="min-w-0 flex-1 overflow-y-auto pb-1">{children}</main>
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
