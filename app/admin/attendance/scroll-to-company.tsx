'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * After a shift save/edit/duplicate/archive, the server action redirects to /admin/attendance?companyId=… .
 * Next.js App Router's server-action redirect() does not reliably carry a #hash, so instead of an anchor we
 * read the companyId (or editShift) query param on mount and scroll the shift-schedules card into view — so
 * saving a shift leaves you at the shift list, not scrolled back to the top. Since ec4cbf63 rev-6 the shift
 * list is ONE flat card (id="shift-schedules") with a Company column rather than a card per company, so the
 * scroll target no longer depends on WHICH company the shift belongs to. Pure client-side; renders nothing.
 */
export function ScrollToCompany() {
  const params = useSearchParams();
  const companyId = params.get('companyId');
  const editShift = params.get('editShift');
  useEffect(() => {
    if (!companyId && !editShift) return;
    const el = document.getElementById('shift-schedules');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [companyId, editShift]);
  return null;
}
