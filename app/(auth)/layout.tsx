import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
// Same stylesheets, in the same order, as the shell's root layout (app/(app)/layout.tsx).
import '../globals.css';
import './login/login.css';
import '../onboarding-workspace.css';
import '../atelier.css';
import { Providers } from '../providers';
import { currentUiTheme } from '@/lib/ui-theme-server';
import { fontVariables, rootMetadata } from '../root-document';

export async function generateMetadata(): Promise<Metadata> {
  return rootMetadata();
}

/**
 * Root layout for the login flow (ADR-0072, lib/auth-routes.ts): fonts, theme and intl, with no sidebar, top bar
 * or session gate. It is a separate root layout from the authenticated shell, so Next.js does a full page load
 * between them and a session-expiry redirect to /login always replaces the whole shell.
 */
export default async function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  const uiTheme = await currentUiTheme();
  return (
    <html lang={locale} data-ui-theme={uiTheme} className={`${fontVariables} h-full antialiased`} suppressHydrationWarning>
      <body className="h-dvh overflow-auto bg-canvas font-sans">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
