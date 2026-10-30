"use client";

import { ThemeProvider } from "next-themes";
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
      {children}
    </ThemeProvider>
  );
}
