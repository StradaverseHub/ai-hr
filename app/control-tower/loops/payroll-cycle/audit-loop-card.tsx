/** AI v2 P2-2a — the Audit loop's place in the Payroll cycle pipeline (the third loop, after pay day).
 *
 * THE SLOT FOR P2-2b. The Audit loop and its read are built separately; until that read exists the overview passes
 * `status: null` and this card shows what the loop is for and no status (the brief: "show its status only if its read
 * exists"). P2-2b replaces the `AuditLoopStatus` type with its own read's shape and renders it here, in this file only.
 * The page hands in its copy (the catalogue's aiCentre.payrollCycle.audit), so this stays a plain component. */
export type AuditLoopStatus = null;
export type AuditLoopCopy = Readonly<{ title: string; done: string; note: string }>;

export function AuditLoopCard({ status, copy }: { status: AuditLoopStatus; copy: AuditLoopCopy }) {
  return (
    <li data-loop-card="audit" data-audit-status={status === null ? 'none' : 'read'} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{copy.title}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{copy.done}</p>
      <p className="border-t border-border pt-2 text-xs text-muted-foreground">{copy.note}</p>
    </li>
  );
}
