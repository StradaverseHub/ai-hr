'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function RefreshWorkbookList() {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [router]);
  return null;
}
