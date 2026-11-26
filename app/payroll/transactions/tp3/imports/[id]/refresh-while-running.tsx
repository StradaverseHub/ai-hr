'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** 5084d02e — re-reads a Form TP3 import's page every few seconds while its job is still running. */
export function RefreshWhileRunning({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => router.refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [router, running]);
  return null;
}
