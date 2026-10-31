/**
 * What both root layouts share: the font faces on <html> and the public metadata. The login flow
 * (app/(auth)/layout.tsx) and the authenticated shell (app/(app)/layout.tsx) are separate root layouts so
 * that Next.js does a full page load between them; see ADR-0072 and lib/auth-routes.ts.
 */
import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Geist_Mono, DM_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import { publicLoginPresentation } from '@/lib/login-presentation-server';

// r396: Classic's faces are no longer the default, so they are not preloaded on every page (they still load,
// on demand, for a Classic user). Monolith's two faces preload.
const jakarta = Plus_Jakarta_Sans({ variable: '--font-jakarta', subsets: ['latin'], display: 'swap', preload: false });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'], preload: false });
// r396 — Monolith's faces (docs/design/monolith/README.md §2), loaded BESIDE Classic's. Both sets of
// variables are always on <html>; app/globals.css maps --font-jakarta / --font-geist-mono onto these two
// only under `:root[data-ui-theme="monolith"]`, so Classic keeps Jakarta + Geist Mono untouched and the
// CJK / Thai / Tamil fallback chain in --font-sans is shared by both themes.
// Same official face, self-hosted to avoid Next 16.3's extensionless Google-font URL parser failure.
// The unmodified variable file supplies exactly the three previously requested normal weights.
const schibsted = localFont({
  src: [
    { path: './fonts/schibsted-grotesk/SchibstedGrotesk-Variable.ttf', weight: '400', style: 'normal' },
    { path: './fonts/schibsted-grotesk/SchibstedGrotesk-Variable.ttf', weight: '500', style: 'normal' },
    { path: './fonts/schibsted-grotesk/SchibstedGrotesk-Variable.ttf', weight: '600', style: 'normal' },
  ],
  variable: '--font-schibsted',
  display: 'swap',
  preload: true,
});
const dmMono = DM_Mono({ variable: '--font-dm-mono', subsets: ['latin'], weight: ['400', '500'] });
export const fontVariables = `${jakarta.variable} ${geistMono.variable} ${schibsted.variable} ${dmMono.variable}`;

// Public appearance uses the same installation-selected projection as the login page.
// Keep the fallback in public/: a file-convention app/favicon.ico would take precedence over this setting.
export async function rootMetadata(): Promise<Metadata> {
  const presentation = await publicLoginPresentation();
  return { title: 'AIHR', description: 'AI-native HR platform',
    icons: { icon: presentation.iconUrl || '/login/favicon.svg' } };
}
