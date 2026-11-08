"use client";

import { ThemeProvider } from "next-themes";
import { Suspense } from 'react';
import { NavigationFeedback } from '@/components/navigation-feedback';
import { ActionFeedbackProvider } from '@/components/action-feedback';
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
      <ActionFeedbackProvider><PageStyleRecovery />
      <Suspense fallback={null}><NavigationFeedback /></Suspense>
      {children}</ActionFeedbackProvider>
    </ThemeProvider>
  );
}
