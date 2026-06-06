import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
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

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full font-sans">
        <Providers>
          <div className="flex min-h-dvh">
            <Sidebar isAdmin={isAdmin(session)} />
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-14 items-center justify-between border-b border-border px-6">
                <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                  <span className="inline-flex size-2 rounded-full bg-amber-500" title="Dev session" />
                  Demo Group
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                    dev
                  </span>
                  <DevIdentitySwitcher principals={principals} current={session.userId ?? ''} />
                </div>
                <div className="flex items-center gap-3">
                  <CompanySwitcher companies={allowed} selected={scopeIds} />
                  <ThemeToggle />
                </div>
              </header>
              <main className="min-w-0 flex-1 p-6">{children}</main>
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
