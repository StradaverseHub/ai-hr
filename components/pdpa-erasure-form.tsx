'use client';

/**
 * DPO PII-erasure form (ADR-0030). Calls the retention-guarded erasePersonPii server action and shows the
 * report — exactly what was destroyed and what was withheld under statutory retention. Destructive, so it
 * is gated behind an explicit confirmation checkbox.
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { erasePersonPiiAction, type ErasureActionResult } from '@/app/admin/privacy/actions';

const SCOPES = ['contact', 'financial', 'identity', 'statutory-ids', 'all'] as const;
const SCOPE_KEY: Record<(typeof SCOPES)[number], string> = {
  contact: 'scopeContact',
  financial: 'scopeFinancial',
  identity: 'scopeIdentity',
  'statutory-ids': 'scopeStatutoryIds',
  all: 'scopeAll',
};

export function PdpaErasureForm({ initialEmploymentId = '' }: { initialEmploymentId?: string }) {
  const t = useTranslations('admin.privacy');
  const [employmentId, setEmploymentId] = useState(initialEmploymentId);
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('contact');
  const [reason, setReason] = useState('');
  const [requestRef, setRequestRef] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ErasureActionResult | null>(null);
  const [pending, start] = useTransition();

  const run = () => {
    setResult(null);
    start(async () => {
      const r = await erasePersonPiiAction({ employmentId, scope, reason, requestRef });
      setResult(r);
      if (r.ok) setConfirmed(false);
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('fieldEmploymentId')}>
          <input value={employmentId} onChange={(e) => setEmploymentId(e.target.value)} placeholder={t('fieldEmploymentIdHint')} className={inputCls} />
        </Field>
        <Field label={t('fieldScope')}>
          <select value={scope} onChange={(e) => setScope(e.target.value as (typeof SCOPES)[number])} className={inputCls}>
            {SCOPES.map((sc) => (
              <option key={sc} value={sc}>
                {t(SCOPE_KEY[sc])}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fieldRef')}>
          <input value={requestRef} onChange={(e) => setRequestRef(e.target.value)} placeholder="DPO-2026-001" className={inputCls} />
        </Field>
        <Field label={t('fieldReason')}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
        </Field>
      </div>

      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
        <span>{t('confirmLabel')}</span>
      </label>

      <Button size="sm" disabled={!confirmed || pending || !employmentId.trim() || !requestRef.trim()} onClick={run}>
        {pending ? t('running') : t('runErasure')}
      </Button>

      {result && !result.ok && <p className="text-sm text-rose-700 dark:text-rose-400">{t('errorPrefix')}: {result.error}</p>}
      {result && result.ok && (
        <div className="space-y-1 rounded-lg bg-background p-3 text-sm">
          <p className="font-medium text-emerald-700 dark:text-emerald-400">{t('resultDone', { shredded: result.report.shreddedKeys })}</p>
          <p>
            <span className="font-medium">{t('resultErased')}:</span> {result.report.erased.length ? result.report.erased.join(', ') : '—'}
          </p>
          {result.report.withheld.length > 0 && (
            <div>
              <p className="font-medium">{t('resultWithheld')}:</p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {result.report.withheld.map((w) => (
                  <li key={w.field}>
                    {w.field} — {w.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
