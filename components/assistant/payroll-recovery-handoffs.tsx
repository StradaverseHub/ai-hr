import 'server-only';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {getBrowserCommandSession} from '@/lib/session';
import {readPayrollRecoveryHandoffs} from '@/core/assistant-actions/payroll-recovery-handoff';

export async function PayrollRecoveryHandoffs(){
 const t=await getTranslations('assistant.workspace.payrollRecoveryHandoffs');
 try{
  const selected=await getBrowserCommandSession();
  const ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(grant=>({...grant}))};
  const rows=await readPayrollRecoveryHandoffs(ctx);
  if(!rows.length)return null;
  return <section className="space-y-3" aria-label={t('title')}>
   <h2 className="font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('description')}</p>
   <ul className="space-y-2">{rows.map(row=><li key={row.batchId} className="rounded-md border border-border p-3">
    <p className="text-sm">{row.company} · {row.payPeriod}{row.cycle?` · ${row.cycle}`:''}</p>
    <Link href={row.href} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t(row.operation)}</Link>
   </li>)}</ul><p className="text-xs text-muted-foreground">{t('scope')}</p>
   <Link href="/payroll" className="inline-flex min-h-11 items-center text-sm underline">{t('all')}</Link>
  </section>;
 }catch{return <p role="status" className="text-sm">{t('unavailable')}</p>;}
}
