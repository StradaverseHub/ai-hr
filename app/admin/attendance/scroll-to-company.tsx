'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * After a shift save/edit/duplicate/archive on a multi-company Attendance Policy page, the server action
 * redirects to /admin/attendance?companyId=… . Next.js App Router's server-action redirect() does not
 * reliably carry a #hash, so instead of an anchor we read the companyId query param on mount and scroll the
 * matching company card (id="shifts-${companyId}") into view — so saving a shift for Company B leaves you at
 * Company B, not scrolled back to the top (Company A). Pure client-side; renders nothing.
 */
export function ScrollToCompany() {
  const params = useSearchParams();
  const companyId = params.get('companyId');
  useEffect(() => {
    if (!companyId) return;
    const el = document.getElementById(`shifts-${companyId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [companyId]);
  return null;
}
