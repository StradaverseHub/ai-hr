'use client';
import { useEffect, useState } from 'react';
import type { LifecycleV9CaseDetail, LifecycleV9Command } from '@/packs/lifecycle/service';
import { unresolvedSourceRuns, unresolvedWorkflowDeliveries, type Case } from '@/lib/lifecycle-v9-model';
import { readV9Case } from './actions';

const displayDate = (date: string) => date ? `${date.slice(8)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '—';
export function CaseCalculator({ c, busy, command }: { c: Case; busy: boolean; command: (command: LifecycleV9Command) => void }) {
  const [detail, setDetail] = useState<LifecycleV9CaseDetail | null>(null), [error, setError] = useState(''), [reason, setReason] = useState('');
  useEffect(() => {
    let active = true; setDetail(null); setError('');
    readV9Case(c.id).then(result => { if (!active) return; if (result.ok) setDetail(result.detail); else setError(result.error); });
    return () => { active = false; };
  }, [c.id, c.revision]);
  if (c.module !== 'off') return null;
  const calc = detail?.calculation, current = detail?.case.revision === c.revision;
  const frozen = c.finalFigures;
  const values = frozen ? [
    ['Last working day', displayDate(frozen.lastDay)], ['Leave encashment / recovery', `${frozen.leaveDays} days`],
    ['Amount', `${frozen.currency} ${frozen.amount}`], ['Final pay date', displayDate(frozen.payDate)], ['Payroll handover', frozen.payrollReference],
  ] : calc ? [
    ['Calculated last working day', displayDate(calc.calculatedLastDay)], ['Source last working day', displayDate(calc.sourceLastDay)],
    ['Effective last working day', displayDate(calc.lastDay)], ['Notice period', `${calc.notice.value} ${calc.notice.unit}(s)`],
    ['Notice source', calc.noticeSource], ['Unserved notice', `${calc.unservedDays} days`],
    ['Remaining leave', calc.remainingLeave === null ? 'Awaiting Leave source' : `${calc.remainingLeave} days`],
    ['Leave used to offset notice', `${calc.offsetDays} days`], ['Leave encashment / recovery', calc.encashDays === null ? '—' : `${calc.encashDays} days`],
    ['Daily rate', calc.dailyRate === null ? '—' : `${calc.currency} ${calc.dailyRate.toFixed(2)}`],
    ['Amount', calc.amount === null ? '—' : `${calc.currency} ${calc.amount.toFixed(2)}`], ['Final pay date', displayDate(calc.payDate)],
  ] : [];
  const deliveries = unresolvedWorkflowDeliveries(c), sourceRuns = unresolvedSourceRuns(c);
  const open = sourceRuns.length > 0 || deliveries.length > 0 || c.tasks.some(t => !['done', 'notNeeded'].includes(t.status)) || c.items.some(i => !['done', 'notNeeded'].includes(i.status));
  return <section className="v9-panel v9-stack"><h2>Leaver calculator</h2>
    {error && <p className="v9-error" role="alert">{error}</p>}
    {!frozen && !detail && !error && <p role="status" className="v9-muted">Loading salary and Leave figures…</p>}
    <div className="v9-fields">{values.map(([label, value]) => <div key={label}><span className="v9-muted">{label}</span><div>{value}</div></div>)}</div>
    {calc && !frozen && <>
      {calc.missing.length > 0 && <div className="v9-notice v9-warning"><strong>Sources needed</strong><ul>{calc.missing.map(m => <li key={m}>{m}</li>)}</ul></div>}
      {calc.lastDay !== c.facts.lastDay && <p className="v9-notice v9-warning">The calculated date differs from this case. Confirm the source date or record a date adjustment before clearance.</p>}
      {calc.reductionStale && <p className="v9-notice v9-warning">The saved encashment reduction no longer applies to the current balance. Review the adjustment.</p>}
      {['pending', 'submitted'].includes(c.state) && <label className="v9-actions"><input type="checkbox" checked={c.settlementOptions?.keepSourceDate ?? false} disabled={busy || !reason.trim()} onChange={e => command({ type: 'settlementOptions', reason, options: { override: c.settlementOptions?.override ?? null, keepSourceDate: e.target.checked, offsetLeave: c.settlementOptions?.offsetLeave ?? false, reduceEncashment: c.settlementOptions?.reduceEncashment ?? null } })}/>Keep the source last working day</label>}
      {!!sourceRuns.length && <p className="v9-notice v9-warning">{sourceRuns.length} workflows from recorded actions still need completion or review. Clearing this case requires an exception reason.</p>}
      {!!deliveries.length && <p className="v9-notice v9-warning">{deliveries.length} workflow email deliveries still need confirmation or review. Clearing this case stops unstarted deliveries and requires an exception reason.</p>}
      {['pending', 'submitted'].includes(c.state) && <label className="v9-field"><span>{c.state === 'pending' ? 'Date decision reason' : open ? 'Exception clearance reason *' : 'Clearance note / date decision reason'}</span><textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder={open ? 'Explain how outstanding work or unreturned items will be settled.' : 'Record the clearance or source date decision.'}/></label>}
      {c.state === 'submitted' && <>
        <button type="button" className="v9-button v9-button-primary" disabled={busy || !current || !calc.ready || calc.lastDay !== c.facts.lastDay || open && !reason.trim()} onClick={() => command({ type: 'clear', sourceRevision: calc.sourceRevision, reason })}>Confirm clearance and hand over to Payroll</button>
      </>}
      <p className="v9-muted">Salary and Leave come from their current records. Clearance freezes these figures for Payroll review.</p>
    </>}
  </section>;
}
