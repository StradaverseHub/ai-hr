import type React from 'react';
import { Card } from '@/components/ui';

/** Shared document presentation; authorization and recorded figures stay with each reader. */
export function PayslipRow({ label, value, muted, quantity }: { label: string; value: React.ReactNode; muted?: boolean; quantity?:React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={`min-w-0 break-words ${muted ? 'text-muted-foreground' : ''}`}>{label}</span>
      {quantity != null && <span className="ms-auto text-right text-xs tabular-nums">{quantity}</span>}
      <span className={`shrink-0 text-right tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

export function PayslipInformation({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[2fr_3fr] items-start gap-2 break-words text-sm leading-5">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{value || '—'}</dd>
    </div>
  );
}

/** One card in the payslip stack. The screen used to be a single tall card with <section>s inside it. */
export function PayslipBlock({ title, children, tone = "slate", aligned = false }: { title: string; children: React.ReactNode; tone?:"slate"|"earn"|"deduct"|"other"; aligned?: boolean }) {
  return (
    <Card className={`overflow-hidden ${aligned ? "flex h-full flex-col" : ""}`}>
      <h2 className={`px-4 py-2 text-center text-xs font-semibold uppercase tracking-wide text-white ${tone==='earn'?'bg-teal-700':tone==='deduct'?'bg-orange-800':tone==='other'?'bg-violet-700':'bg-slate-600'}`}>{title}</h2>
      <div className={`p-4 ${aligned ? "flex flex-1 flex-col" : ""}`}>{children}</div>
    </Card>
  );
}

