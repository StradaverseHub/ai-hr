"use client";

import { ThemeProvider } from "next-themes";
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { isLifecycleV9Path } from '@/lib/lifecycle-v9-routing';
import { PageStyleRecovery } from '@/components/page-style-recovery';

export function Providers({ children, forcedTheme, lifecycleV9 = false }: { children: React.ReactNode; forcedTheme?: string; lifecycleV9?: boolean }) {
  const pathname = usePathname();
  // Next retains the root layout during client navigation. Crossing the V9 shell boundary
  // needs a fresh document so the supplied complete shell never nests in the incumbent shell.
  useEffect(() => {
    if (lifecycleV9 !== isLifecycleV9Path(pathname)) window.location.reload();
  }, [lifecycleV9, pathname]);
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
