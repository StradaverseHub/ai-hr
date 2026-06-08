import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Suspense } from 'react';
import { Providers } from './providers';
import { Sidebar } from '@/components/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { Toaster } from '@/components/ui/sonner';
import { ToastFromQuery } from '@/components/ui/toast-trigger';
import { DevIdentitySwitcher } from '@/components/dev-identity-switcher';
import { CompanySwitcher } from '@/components/company-switcher';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { listPrincipals } from '@/lib/principals';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';

const jakarta = Plus_Jakarta_Sans({ variable: '--font-jakarta', subsets: ['latin'], display: 'swap' });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'AI HR',
  description: 'AI-native HR platform',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [session, principals] = await Promise.all([getSession(), listPrincipals()]);
  const allowed = await allowedCompanies(session);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-dvh overflow-hidden bg-canvas p-3 font-sans lg:p-4">
        <Providers>
          {/* Detached floating layout: the rail, the top bar, and each content card
              float separately on the canvas with gutters between them. */}
          <div className="flex h-full gap-3 lg:gap-4">
            <Sidebar isAdmin={isAdmin(session)} />
            <div className="flex min-w-0 flex-1 flex-col gap-3 lg:gap-4">
              <header className="flex h-16 shrink-0 items-center justify-between gap-4 rounded-[1.25rem] border border-border bg-card px-4 shadow-[var(--shadow-card)]">
                <div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
                  <span className="inline-flex size-1.5 rounded-full bg-amber-500" title="Dev session" />
                  <span className="font-medium text-foreground/80">Demo Group</span>
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    dev
                  </span>
                  <DevIdentitySwitcher principals={principals} current={session.userId ?? ''} />
                </div>
                <div className="flex items-center gap-2.5">
                  <CompanySwitcher companies={allowed} selected={scopeIds} />
                  <div className="h-5 w-px bg-border" />
                  <ThemeToggle />
                </div>
              </header>
              <main className="min-w-0 flex-1 overflow-y-auto pb-1">{children}</main>
            </div>
          </div>
          <Suspense fallback={null}>
            <ToastFromQuery />
          </Suspense>
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
