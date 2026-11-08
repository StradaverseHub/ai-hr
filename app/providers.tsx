"use client";

import { ThemeProvider } from "next-themes";
import { Suspense } from 'react';
import { NavigationFeedback } from '@/components/navigation-feedback';
import { PageStyleRecovery } from '@/components/page-style-recovery';

export function Providers({ children, forcedTheme }: { children: React.ReactNode; forcedTheme?: string }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      forcedTheme={forcedTheme}
    >
      <PageStyleRecovery />
      <Suspense fallback={null}><NavigationFeedback /></Suspense>
      {children}
    </ThemeProvider>
  );
}
