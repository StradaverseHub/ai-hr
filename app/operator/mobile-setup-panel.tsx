'use client';
import Image from 'next/image';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { emptyOperatorState, type OperatorActionState } from './action-state';
import { importMobileSetupAction, requestMobileSetupIssueAction } from './actions';

/** Serializable view assembled by the customer page from core/operator-mobile-setup (ADR-0161). */
export type OperatorMobileSetupView = {
  signs: boolean;
  state: 'issued' | 'imported' | 'none' | 'invalid';
  reason: string | null;
  keyId: string | null;
  expires: string | null;
  expiresSoon: boolean;
  origin: string | null;
  organization: string | null;
  recorded: string | null;
  failure: { reason: string; at: string } | null;
  link: string | null;
  qr: string | null;
  pending: boolean;
  requests: { id: string; action: 'issue' | 'import'; status: 'pending' | 'running' | 'done' | 'failed'; error: string | null; created: string }[];
};

function Result({ state, success }: { state: OperatorActionState; success: string }) {
  return state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p>
    : state.ok ? <p role="status" className="text-sm text-foreground">{success}</p> : null;
}

export function OperatorMobileSetupPanel({ tenantId, view }: { tenantId: string; view: OperatorMobileSetupView }) {
  const t = useTranslations('operatorMobileSetup'), o = useTranslations('operator');
  const [issueState, issueAction, issuing] = useActionState(requestMobileSetupIssueAction, emptyOperatorState);
  const [importState, importAction, importing] = useActionState(importMobileSetupAction, emptyOperatorState);
  const reason = (code: string) => t.has(`reasons.${code}`) ? t(`reasons.${code}`) : t('reasons.unknown', { code });
  const usable = view.state === 'issued' || view.state === 'imported';
  return <Card className="space-y-5 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <SectionHeader title={t('title')}/>
      <Badge variant={usable ? (view.expiresSoon ? 'warning' : 'success') : view.state === 'invalid' ? 'danger' : 'default'}>{t(`state.${view.state}`)}</Badge>
    </div>
    <p className="text-sm text-muted-foreground">{t('description')}</p>
    {view.state === 'invalid' && view.reason && <p role="alert" className="text-sm text-destructive">{t('invalid', { reason: reason(view.reason) })}</p>}
    {usable && view.expiresSoon && <p role="alert" className="text-sm">{t('expiresSoon', { date: view.expires ?? '' })}</p>}
    {view.state !== 'none' && <dl className="grid gap-4 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{t('validUntil')}</dt><dd className="mt-1 font-medium">{view.expires ?? '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('keyId')}</dt><dd className="mt-1 break-all font-medium">{view.keyId ?? '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('server')}</dt><dd className="mt-1 break-all font-medium">{view.origin ?? '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('organizationCode')}</dt><dd className="mt-1 font-medium">{view.organization ?? '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('recorded')}</dt><dd className="mt-1 font-medium">{view.recorded ?? '—'}</dd></div>
    </dl>}
    {view.failure && <p className="text-sm text-muted-foreground">{t('lastFailure', { reason: reason(view.failure.reason), at: view.failure.at })}</p>}
    {view.link && <div className="space-y-3">
      {view.qr && <Image src={view.qr} alt={t('qrAlt')} width={192} height={192} unoptimized className="rounded-lg bg-white"/>}
      <p className="text-sm font-medium">{t('linkLabel')}</p>
      <p className="break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">{view.link}</p>
    </div>}
    {view.pending && <p role="status" className="text-sm text-muted-foreground">{t('pending')}</p>}
    <form action={issueAction} className="space-y-2 border-t border-border pt-4">
      <input type="hidden" name="tenantId" value={tenantId}/>
      <p className="text-xs text-muted-foreground">{view.signs ? t('issueHelp') : t('issueUnavailable')}</p>
      <button type="submit" className={btnPrimary} disabled={!view.signs || view.pending || issuing}>{issuing ? t('submitting') : view.state === 'none' ? t('issue') : t('reissue')}</button>
      <Result state={issueState} success={t('issueQueued')}/>
    </form>
    <form action={importAction} className="space-y-2 border-t border-border pt-4">
      <input type="hidden" name="tenantId" value={tenantId}/>
      <label className="block space-y-1 text-sm font-medium">{t('importLabel')}
        <input type="file" name="setupFile" accept=".json,application/json" required disabled={view.pending || importing} className={inputCls}/>
        <span className="block text-xs font-normal text-muted-foreground">{t('importHelp')}</span>
      </label>
      <button type="submit" className={btnGhost} disabled={view.pending || importing}>{importing ? t('submitting') : t('import')}</button>
      <Result state={importState} success={t('importQueued')}/>
    </form>
    <div className="border-t border-border pt-4">
      <h3 className="text-sm font-semibold">{t('history')}</h3>
      {view.requests.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t('noRequests')}</p> :
        <ul className="mt-2 divide-y divide-border">{view.requests.map(r => <li key={r.id} className="space-y-1 py-2.5">
          <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-medium">{t(`action.${r.action}`)}</span>
            <Badge variant={r.status === 'failed' ? 'danger' : r.status === 'done' ? 'success' : 'warning'}>{o(`status.${r.status}`)}</Badge></div>
          <p className="text-xs text-muted-foreground">{r.created}</p>
          {r.error && <p className="text-sm text-destructive">{reason(r.error)}</p>}
        </li>)}</ul>}
    </div>
  </Card>;
}
