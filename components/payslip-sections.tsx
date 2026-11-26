import type React from 'react';
import { Card } from '@/components/ui';

/** Shared document presentation; authorization and recorded figures stay with each reader. */
export function PayslipRow({ label, value, muted, quantity, after }: { label: string; value: React.ReactNode; muted?: boolean; quantity?:React.ReactNode;
  /** AI v2 W5 — beside the label, outside it: the line's "Why?" link on the employee's own payslip screen. */
  after?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={`min-w-0 break-words ${muted ? 'text-muted-foreground' : ''}`}>{label}</span>
      {after}
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

/**
 * 1ebba97e — the Net Pay band, ONE component for the admin review screen (app/payroll/individual-payslip)
 * and the employee's own payslip (app/me/payslip/statement.tsx).
 *
 * WHY IT IS NOT A <Card>. Both screens drew this band as `<Card className="bg-primary text-primary-foreground">`,
 * and Card stamps `data-ui-card`. Atelier, the default theme, repaints every `main [data-ui-card]` with
 * `background: var(--card)` (app/atelier.css, unlayered, so it beats the `bg-primary` utility): white text on
 * a white card, and the figure the reader looks for first looked like an empty box. Monolith's Card appends
 * `monolith:bg-transparent`, and its primary-foreground is the page colour, so the same clash recurs there.
 * A plain element carries no theme hook, so no theme rule can reach it.
 *
 * WHY foreground/background. They are the one token pair every theme (Atelier, Monolith, Classic) defines as
 * each other's contrast, in light and in dark — ink on paper, inverted. So the band is a dark bar with light
 * writing on a light page and the reverse on a dark one, never one colour twice.
 * test/payslip-net-pay-band-1ebba97e.dom.test.tsx checks the pair's contrast in all six combinations.
 *
 * PRINT: browsers drop background fills by default, which would leave light text on white paper, so the
 * printed band is an outlined row in black ink instead.
 *
 * Presentation only: `value` is the caller's already-formatted, already-recorded net pay.
 */
export function NetPayBand({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      data-payslip-net-pay
      className="flex items-baseline justify-between gap-4 rounded-xl bg-foreground px-6 py-5 text-background print:border print:border-black print:bg-transparent print:text-black"
    >
      <span className="text-sm font-semibold uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-bold tabular-nums">{value}</span>
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
