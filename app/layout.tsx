import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Suspense } from 'react';
import { Providers } from './providers';
import { Sidebar } from '@/components/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { Toaster } from '@/components/ui/sonner';
import { ToastFromQuery } from '@/components/ui/toast-trigger';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'AI HR',
  description: 'AI-native HR platform',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full font-sans">
        <Providers>
          <div className="flex min-h-dvh">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-14 items-center justify-between border-b border-zinc-200 px-6 dark:border-zinc-800">
                <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                  <span className="inline-flex size-2 rounded-full bg-amber-500" title="Dev session" />
                  Demo Group
                  <span className="text-zinc-400 dark:text-zinc-600">·</span>
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                    dev session
                  </span>
                </div>
                <ThemeToggle />
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
