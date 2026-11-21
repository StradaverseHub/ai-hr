'use client';
import {useNavIndex} from '@/components/nav-index-context';
import {useContractReasonLabel} from '@/lib/contract-reason-copy';
import { useContractSharedCopy } from '@/lib/contract-shared-copy';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
export function SharedContractNavigation() {
  const copy = useContractSharedCopy();
  const path = usePathname();
  const {entries}=useNavIndex();
  const permitted=new Set(entries.map(entry=>entry.href));
  const links=[
    {href:'/lifecycle/contracts',label:'Contract cases',active:path==='/lifecycle/contracts'},
    {href:'/lifecycle/contracts/postings',label:'Personnel postings',active:path.includes('/postings')},
    {href:'/lifecycle/contracts/settings',label:'Settings and access',active:path.includes('/settings')},
    {href:'/automation/workflows',label:'HR Automation',active:false},
  ].filter(link=>permitted.has(link.href));
  if(!links.length)return <div className="v9-tabs" aria-hidden="true" style={{minHeight:44}}/>;
  return (
    <nav className="v9-tabs" style={{minHeight:44}} aria-label={copy('Contract Management')}>
      {links.map(link=><Link key={link.href} className={'v9-button'+(link.active?' v9-button-primary':'')} href={link.href} aria-current={link.active?'page':undefined}>{copy(link.label)}</Link>)}
    </nav>
  );
}
export function ContractTerms({
  decision,
  reasons = [],
}: {
  reasons?:readonly {code:string;label:string|null}[];
  decision: {
    kind: string;
    startOn: string | null;
    endOn: string | null;
    salaryCents: string | null;
    payChanges: boolean;
    reason: string;
    endReason: string | null;
  };
}) {
  const copy = useContractSharedCopy(),reasonLabel=useContractReasonLabel();
  const endingReason=decision.endReason?(reasonLabel(decision.endReason,reasons.find(reason=>reason.code===decision.endReason)?.label)):null;
  return (
    <dl className="contract-facts">
      <div>
        <dt>{copy('Decision')}</dt>
        <dd>
          {decision.kind === 'convert'
            ? copy('Convert to permanent')
            : decision.kind === 'renew'
              ? copy('Renew')
              : copy('End contract')}
        </dd>
      </div>
      {decision.startOn && (
        <div>
          <dt>{copy('New start')}</dt>
          <dd>{contractDate(decision.startOn)}</dd>
        </div>
      )}
      {decision.endOn && (
        <div>
          <dt>{copy('New end')}</dt>
          <dd>{contractDate(decision.endOn)}</dd>
        </div>
      )}
      <div>
        <dt>{copy('Pay change')}</dt>
        <dd>{decision.payChanges ? contractSalary(decision.salaryCents) : copy('No change')}</dd>
      </div>
      <div>
        <dt>{copy('Reason')}</dt>
        <dd className="v9-prewrap">{endingReason || decision.reason || '—'}</dd>
      </div>
      {decision.endReason && decision.reason && (
        <div>
          <dt>{copy('Notes')}</dt>
          <dd className="v9-prewrap">{decision.reason}</dd>
        </div>
      )}
    </dl>
  );
}
export const contractDate = (value: string | null | undefined) =>
  value ? value.slice(0, 10).split('-').reverse().join('/') : '—';
export const contractSalary = (value: string | null | undefined) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(Number(value) / 100);
export function ContractFeedback({ error, status }: { error?: string; status?: string }) {
  const copy = useContractSharedCopy();
  return (
    <>
      {error && (
        <p className="v9-notice v9-error" role="alert">
          {copy(error)}
        </p>
      )}
      {status && (
        <p className="v9-notice" role="status">
          {copy(status)}
        </p>
      )}
    </>
  );
}
export function ContractPanel({ title, children }: { title: string; children: ReactNode }) {
  const copy = useContractSharedCopy();
  return (
    <section className="v9-panel v9-stack">
      <h2>{copy(title)}</h2>
      {children}
    </section>
  );
}
