'use client';

/**
 * 711adcd2 — the Ordinary Rate of Pay card: TWO INDEPENDENT TICK BOXES per pay item.
 *
 * Until migration 0456 there was no switch at all. Which pay items fed a tenant's overtime formula was
 * decided by the item's CATEGORY (every non-statutory Earning paid as a fixed amount counted), and the
 * unpaid-leave daily rate was struck from basic salary alone. 0456 backfilled both columns to exactly that,
 * so the boxes an operator sees on release day describe what the system was already doing, and every one
 * they change from here is a deliberate change they made.
 *
 * WHY THIS IS A CLIENT ISLAND AT ALL. The warning below has to react to the Category select, which lives in
 * the General Information card above and is a plain server-rendered `<select>`. Rather than lift the whole
 * form into the client, the island subscribes to that one control through the form it is already inside.
 * Everything else here is an ordinary checkbox posting to the same server action as the rest of the form.
 *
 * NEITHER BOX IS EVER GREYED OUT. A control the browser will not submit sends nothing at all, and nothing
 * is indistinguishable from "unticked" in the action's FormData — so locking a tick would silently clear a
 * stored flag and re-price somebody's overtime. The deduction case is therefore a WARNING, never a lock.
 * (The word the guard scans for is deliberately absent from this file, comments included — see AGENTS 27.)
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';

export function OrpConfig({
  orpUnpaidLeave,
  orpOvertime,
  kind,
}: {
  orpUnpaidLeave: boolean;
  orpOvertime: boolean;
  /** The Category as the form was RENDERED. Kept in step with the live select by the effect below. */
  kind: string;
}) {
  const t = useTranslations('payComponents');
  const [unpaid, setUnpaid] = useState(orpUnpaidLeave);
  const [overtime, setOvertime] = useState(orpOvertime);
  const [liveKind, setLiveKind] = useState(kind);
  const ref = useRef<HTMLDivElement>(null);

  // Follow the Category select in the card above. Scoped to THIS form (`closest`), never the document, so a
  // second form on a future page cannot drive this card. If the select is not found the card still works —
  // it simply shows the warning based on the Category the row was loaded with.
  useEffect(() => {
    const select = ref.current?.closest('form')?.querySelector<HTMLSelectElement>('select[name="kind"]');
    if (!select) return;
    const sync = () => setLiveKind(select.value);
    sync();
    select.addEventListener('change', sync);
    return () => select.removeEventListener('change', sync);
  }, []);

  const warn = liveKind === 'deduction' && (unpaid || overtime);

  return (
    <div ref={ref} className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('sectionOrpHint')}</p>
      <div className="space-y-3">
        <label className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 p-3">
          <input
            type="checkbox"
            name="orpUnpaidLeave"
            checked={unpaid}
            onChange={(e) => setUnpaid(e.target.checked)}
            className="mt-0.5 size-4 rounded"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium text-foreground">{t('orpUnpaidLeaveLabel')}</span>
            <span className="block text-xs text-muted-foreground">{t('orpUnpaidLeaveHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 p-3">
          <input
            type="checkbox"
            name="orpOvertime"
            checked={overtime}
            onChange={(e) => setOvertime(e.target.checked)}
            className="mt-0.5 size-4 rounded"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium text-foreground">{t('orpOvertimeLabel')}</span>
            <span className="block text-xs text-muted-foreground">{t('orpOvertimeHint')}</span>
          </span>
        </label>
      </div>
      {warn && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <span>{t('orpDeductionWarning')}</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t('orpStatutoryNote')}</p>
    </div>
  );
}
