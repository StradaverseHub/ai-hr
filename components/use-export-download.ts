'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { exportFilename } from '@/lib/export-download';

export function useExportDownload() {
  const common = useTranslations('common');
  const report = useTranslations('letters.reports');
  const errors = useTranslations('labelExcelRoundTrip');
  const [phase, setPhase] = useState<'requesting' | 'receiving' | null>(null);
  const running = useRef(false);

  async function download(url: URL, options?: RequestInit) {
    if (running.current || url.origin !== location.origin) return false;
    running.current = true;
    setPhase('requesting');
    try {
      const response = await fetch(url, { ...options, cache: 'no-store', redirect: 'error' });
      const name = exportFilename(response.headers.get('content-disposition'));
      if (!response.ok || !name) throw new Error('Export did not return an attachment');
      setPhase('receiving');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = name;
      document.body.append(link);
      try { link.click(); } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
      toast.success(name);
      return true;
    } catch {
      toast.error(errors('downloadFailed'));
      return false;
    } finally {
      running.current = false;
      setPhase(null);
    }
  }

  return {
    download,
    pending: phase !== null,
    status: phase === 'requesting' ? report('working') : phase === 'receiving' ? common('loading') : '',
  };
}
