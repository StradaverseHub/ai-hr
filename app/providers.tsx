"use client";

import { ThemeProvider } from "next-themes";
import { PageStyleRecovery } from '@/components/page-style-recovery';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <PageStyleRecovery />
      {children}
    </ThemeProvider>
  );
}
