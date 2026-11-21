'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

export function AnalyticsRefresh({ label, refreshing }: { label: string; refreshing: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const timer = window.setInterval(refresh, 45_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [router]);
  return <Button variant="outline" type="button" disabled={pending} onClick={() => start(() => router.refresh())}>
    {pending ? refreshing : label}
  </Button>;
}
