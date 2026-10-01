'use client';
import { useActionState } from 'react';
import { PAYSLIP_INFORMATION_FIELDS } from '@/core/payslip-information';
import { savePayslipInformation } from './actions';
import { Button, Card } from '@/components/ui';
export function SettingsForm({companyId, fields, labels}: {companyId:string; fields:readonly string[]; labels:Record<string,string>}) {
  const [state, action, pending] = useActionState(savePayslipInformation, {error: '', saved: false});
  return <form action={action}><input type="hidden" name="companyId" value={companyId}/><Card className="p-6">
    <h2 className="mb-5 font-semibold">{labels.heading}</h2>
    {state.error && <p role="alert" className="mb-4 text-destructive">{state.error}</p>}
    {state.saved && <p role="status" className="mb-4 text-emerald-700 dark:text-emerald-400">{labels.saved}</p>}
    <div className="grid gap-3 sm:grid-cols-2">{PAYSLIP_INFORMATION_FIELDS.map(k => <label key={k} className="flex min-h-11 items-center gap-3 rounded border border-border p-3"><input type="checkbox" name="fields" value={k} defaultChecked={fields.includes(k)} disabled={pending}/>{labels[k]}</label>)}</div>
    <div className="mt-6 flex gap-3"><Button type="submit" disabled={pending}>{pending ? labels.saving : labels.save}</Button><Button asChild><a href="/payroll/setup">{labels.cancel}</a></Button></div>
  </Card></form>;
}
