'use client';
/**
 * WP-E (CF-08) — the bulk release board: one row per person, three results, two steps. The buttons count, for
 * the result picked, who has something to send at each step; each opens a confirmation naming who the step
 * reaches, and only that confirmation posts. The server decides every person again on their locked row
 * (release-service.ts), so these counts are a preview, never the authority.
 */
import { useMemo, useRef, useState, useTransition } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useTranslations } from 'next-intl';
import { Button, inputCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import type { ReleaseBoardCell, ReleaseBoardRow } from '@/packs/performance/service';
import { bulkReleaseAction } from '../onehr-actions';

type Result = 'three' | 'performance' | 'potential' | 'talent' | 'feedback';
type Dialog = { kind: 'leaders' | 'employees' | 'revokeEmployees' | 'revokeBoth'; rows: ReleaseBoardRow[] } | null;
const day = (iso: string | null) => (iso ? todayInKualaLumpur(new Date(iso)) : '');
const cellsOf = (r: ReleaseBoardRow, result: Result): ReleaseBoardCell[] =>
  (result === 'three' ? [r.performance, r.potential, r.talent] : result === 'feedback' ? [] : [r[result]]).filter((c): c is ReleaseBoardCell => !!c);

/** One person, for the result picked: something not with leaders yet (lead), something with leaders not yet with them (emp), a result still waiting on step 1 (gate), and what is not final. */
function stand(r: ReleaseBoardRow, result: Result) {
  const out = { lead: false, emp: false, gate: false, open: false, since: null as string | null };
  if (result === 'feedback') { out.emp = !!r.report?.final && !r.report.employeeAt; return out; }
  for (const c of cellsOf(r, result)) {
    if (!c.final) out.open = true;
    if (!c.leaderAt) out.lead = true;
    if (!c.leaderAt && !c.employeeAt) out.gate = true;
    if (c.leaderAt && !c.employeeAt) { out.emp = true; if (!out.since || c.leaderAt < out.since) out.since = c.leaderAt; }
  }
  return out;
}

export function ReleaseBoard({ cycleId, cycleName, potential, midYear, email, filters, rows }: {
  cycleId: string; cycleName: string; potential: boolean; midYear: boolean; email: 'on' | 'off';
  filters: { businessGroup: string; companyId: string; department: string; status: string }; rows: ReleaseBoardRow[];
}) {
  const t = useTranslations('onehr.resultRelease');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Result>('three');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState(false);
  const [pending, start] = useTransition();
  const revokeRef = useRef<HTMLButtonElement>(null);
  const chosen = rows.filter((r) => picked.has(r.reviewId));
  const counts = useMemo(() => {
    let n1 = 0, n2 = 0, gate = 0;
    for (const r of chosen) { const s = stand(r, result); if (s.lead) n1++; if (s.emp) n2++; else if (s.gate) gate++; }
    return { n1, n2, gate };
  }, [chosen, result]);
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.reviewId)), somePicked = !allPicked && rows.some((r) => picked.has(r.reviewId));
  const toggle = (id: string) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const what = !potential && result === 'three' ? t('what.performance') : t(`what.${result}`);

  function post(to: 'leaders' | 'employees' | 'both', action: 'release' | 'revoke', ids: string[]) {
    const f = new FormData();
    f.set('cycleId', cycleId); f.set('result', result); f.set('to', to); f.set('action', action);
    for (const [k, v] of Object.entries(filters)) if (v) f.set(k, v);
    for (const id of ids) f.append('ids', id);
    start(async () => { await bulkReleaseAction(f); });
  }
  function confirm() {
    if (!dialog) return;
    if (dialog.kind === 'leaders') post('leaders', 'release', dialog.rows.filter((r) => stand(r, result).lead).map((r) => r.reviewId));
    else if (dialog.kind === 'employees') post('employees', 'release', dialog.rows.filter((r) => stand(r, result).emp).map((r) => r.reviewId));
    else post(dialog.kind === 'revokeEmployees' ? 'employees' : 'both', 'revoke', dialog.rows.map((r) => r.reviewId));
  }
  function rowStep(r: ReleaseBoardRow, step: 'leaders' | 'employees') { setResult('three'); setDialog({ kind: step, rows: [r] }); }
  function goTo(id: string) {
    setDialog(null);
    requestAnimationFrame(() => { const box = document.getElementById(`release-pick-${id}`); box?.scrollIntoView({ block: 'center' }); box?.focus(); });
  }

  const l1 = (r: ReleaseBoardRow) => {
    const have = [r.performance, r.potential, r.talent].filter((c): c is ReleaseBoardCell => !!c), dates = have.map((c) => c.leaderAt).filter((d): d is string => !!d).sort();
    if (!have.length) return { text: t('l1.none'), tone: 'none' };
    if (r.state.leadAll) return { text: t('l1.released', { date: day(dates[0] ?? null) }), tone: 'ok' };
    if (dates.length) return { text: t('l1.partly'), tone: 'part' };
    if (r.state.notFinal) return { text: t('l1.notFinal'), tone: 'warn' };
    return { text: t('l1.notReleased'), tone: 'none' };
  };
  const l2 = (r: ReleaseBoardRow) => {
    const have = [r.performance, r.potential, r.talent].filter((c): c is ReleaseBoardCell => !!c), dates = have.map((c) => c.employeeAt).filter((d): d is string => !!d).sort();
    if (!have.length) return { text: t('l2.none'), tone: 'none' };
    if (r.state.toEmp) return { text: t('l2.released', { date: day(dates[0] ?? null) }), tone: 'ok' };
    if (dates.length) return { text: t('l2.partly'), tone: 'part' };
    if (r.state.withLeaders) return { text: t('l2.waiting'), tone: 'warn' };
    return { text: t('l2.after'), tone: 'none' };
  };
  const tone: Record<string, string> = { ok: 'text-emerald-700 dark:text-emerald-400', part: 'text-blue-700 dark:text-blue-400', warn: 'text-amber-700 dark:text-amber-400', none: 'text-muted-foreground' };
  const bandCell = (c: ReleaseBoardCell | null, talent = false) => !c ? <span className="text-muted-foreground">—</span>
    : <span className="flex flex-col"><b translate="no">{c.band}</b>{!talent && <span className={c.final ? 'text-xs text-muted-foreground' : 'text-xs text-amber-700 dark:text-amber-400'}>{t(`stage.${c.final ? 'final' : (c.stage && ['manager', 'hod', 'bu', 'bg', 'group'].includes(c.stage) ? c.stage : 'interim')}`)}</span>}</span>;
  const meta = (r: ReleaseBoardRow) => [r.employeeCode, r.department, r.grade ? t('grade', { grade: r.grade }) : null].filter(Boolean).join(' · ');
  const notFinalNote = midYear ? t('dialog.notFinalMid') : t('dialog.notFinal');
  const emailLine = email === 'on' ? t('dialog.emailOn') : t('dialog.emailOff');

  const body = (() => {
    if (!dialog) return null;
    const list = (items: ReleaseBoardRow[], line: (r: ReleaseBoardRow) => string | null, label?: string) => items.length ? <div className="space-y-1">{label && <p className="text-xs font-medium">{label}</p>}<ul className="max-h-40 space-y-1 overflow-y-auto text-sm">{items.map((r) => <li key={r.reviewId} className="flex flex-wrap justify-between gap-2"><span>{r.name}</span>{line(r) && <span className="text-xs text-muted-foreground">{line(r)}</span>}</li>)}</ul></div> : null;
    if (dialog.kind === 'leaders') {
      const go = dialog.rows.filter((r) => stand(r, result).lead), skip = dialog.rows.length - go.length, open = go.filter((r) => stand(r, result).open);
      const one = go.length === 1 ? go[0] : null;
      return { kicker: t('dialog.step1Kicker'), title: t('dialog.step1Title', { count: go.length }), confirm: t('toLeaders'), danger: false, off: !go.length, content: <>
        <p className="text-sm">{t('dialog.step1Body', { what: potential ? t('dialog.whatThree') : t('dialog.whatPerformance') })}</p>
        {one ? <div className="rounded-md border border-border p-3 text-sm"><p className="font-medium">{one.name}{meta(one) && <span className="font-normal text-muted-foreground"> · {meta(one)}</span>}</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">{([['lineManager', one.leaders.lm], ['hod', one.leaders.hod], ['buCeo', one.leaders.bu]] as const).map(([k, names]) => <div key={k} className="contents"><dt className="text-muted-foreground">{t(`dialog.${k}`)}</dt><dd>{names.length ? names.join(', ') : t('dialog.nobody')}</dd></div>)}</dl></div>
          : list(go, (r) => (r.leaders.lm.length ? t('dialog.lmNamed', { name: r.leaders.lm.join(', ') }) : t('dialog.noLm')), t('dialog.leadersOf'))}
        {list(open, () => null, notFinalNote)}
        <div className="space-y-1 rounded-md bg-muted/40 p-3 text-xs"><p>{t('dialog.noticesLeaders')}</p><p>{emailLine}</p></div>
        {skip > 0 && <p className="text-xs text-muted-foreground">{t('dialog.alreadyWithLeaders', { count: skip })}</p>}
        <p className="text-xs text-muted-foreground">{t('dialog.bgSees')}</p>
      </> };
    }
    if (dialog.kind === 'employees') {
      const go = dialog.rows.filter((r) => stand(r, result).emp), held = dialog.rows.filter((r) => { const s = stand(r, result); return !s.emp && s.gate; }), open = go.filter((r) => stand(r, result).open);
      return { kicker: t('dialog.step2Kicker'), title: t('dialog.step2Title', { count: go.length }), confirm: t('dialog.step2Confirm', { count: go.length }), danger: false, off: !go.length, content: <>
        <p className="text-sm">{result === 'feedback' ? t('dialog.step2Report') : t('dialog.step2Body', { what: potential ? t('dialog.step2WhatThree') : t('dialog.whatPerformance'), cycle: cycleName })}</p>
        {list(go, (r) => { const s = stand(r, result); return s.since ? t('dialog.leadersSince', { date: day(s.since) }) : null; }, t('dialog.goingTo'))}
        {list(open, () => null, notFinalNote)}
        {go.length > 0 && <div className="space-y-1 rounded-md bg-muted/40 p-3 text-xs"><p>{t('dialog.noticesPeople')}</p><p>{emailLine}</p></div>}
        {held.length > 0 && <div className="space-y-2 rounded-md border border-amber-300 p-3 text-sm dark:border-amber-500/40"><p className="font-medium">{t('dialog.held', { count: held.length })}</p>
          <ul className="space-y-1">{held.map((r) => <li key={r.reviewId} className="flex items-center justify-between gap-2"><span>{r.name}</span><Button type="button" size="sm" variant="ghost" onClick={() => goTo(r.reviewId)}>{t('dialog.goTo')}</Button></li>)}</ul>
          <p className="text-xs text-muted-foreground">{t('dialog.heldHelp')}</p></div>}
        <p className="text-xs text-muted-foreground">{t('dialog.canRevoke')}</p>
      </> };
    }
    const both = dialog.kind === 'revokeBoth';
    return { kicker: both ? t('dialog.revokeKickerBoth') : t('dialog.revokeKickerEmployees'), title: t('dialog.revokeTitle', { what, count: dialog.rows.length }), confirm: t('dialog.revokeConfirm'), danger: true, off: !dialog.rows.length,
      content: <p className="text-sm">{both ? t('dialog.revokeBothBody') : t('dialog.revokeEmployeesBody')}</p> };
  })();

  return <section className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="text-sm text-muted-foreground">{t('people', { count: rows.length })}</p>
      <label className="flex items-center gap-2 text-sm">{t('results')}
        <select aria-label={t('results')} value={result} onChange={(e) => setResult(e.target.value as Result)} className={`${inputCls} w-auto`}>
          {potential ? <><option value="three">{t('resultThree')}</option><option value="performance">{t('resultPerformance')}</option><option value="potential">{t('resultPotential')}</option><option value="talent">{t('resultTalent')}</option></> : <option value="three">{t('resultPerformance')}</option>}
          {potential && <option value="feedback">{t('resultFeedback')}</option>}
        </select></label>
    </div>
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/40"><tr>
          <th className="w-10 p-3"><input type="checkbox" aria-label={t('selectAll')} checked={allPicked} ref={(el) => { if (el) el.indeterminate = somePicked; }} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.reviewId)))}/></th>
          {(['person', 'performance', 'potential', 'talent', 'leaders', 'employee'] as const).map((k) => <th key={k} className="whitespace-nowrap p-3">{t(k)}</th>)}
          <th className="p-3"><span className="sr-only">{t('rowAction')}</span></th>
        </tr></thead>
        <tbody className="divide-y divide-border">{rows.map((r) => { const a = l1(r), b = l2(r); return <tr key={r.reviewId} data-review={r.reviewId}>
          <td className="p-3"><input id={`release-pick-${r.reviewId}`} type="checkbox" aria-label={t('select', { name: r.name })} checked={picked.has(r.reviewId)} onChange={() => toggle(r.reviewId)}/></td>
          <td className="p-3"><p className="font-medium">{r.name}</p>{meta(r) && <p className="text-xs text-muted-foreground">{meta(r)}</p>}</td>
          <td className="p-3">{bandCell(r.performance)}</td><td className="p-3">{bandCell(r.potential)}</td><td className="p-3">{bandCell(r.talent, true)}</td>
          <td className="whitespace-nowrap p-3"><span data-step="1" className={tone[a.tone]}>{a.text}</span></td>
          <td className="p-3"><span data-step="2" className={tone[b.tone]}>{b.text}</span>{r.report && <p className="text-xs text-muted-foreground">{t('report', { state: r.report.employeeAt ? t('reportReleased', { date: day(r.report.employeeAt) }) : r.report.final ? t('reportReady') : t('reportBelow') })}</p>}</td>
          <td className="p-3 text-right">{r.state.leadOpen ? <Button type="button" size="sm" variant="outline" onClick={() => rowStep(r, 'leaders')}>{t('rowToLeaders')}</Button>
            : r.state.withLeaders ? <Button type="button" size="sm" onClick={() => rowStep(r, 'employees')}>{t('rowToEmployee')}</Button> : null}</td>
        </tr>; })}</tbody>
      </table>
    </div>
    <div role="toolbar" aria-label={t('stepsLabel')} className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-md border border-border bg-background p-3">
      <span aria-live="polite" className="text-sm font-medium">{chosen.length ? t('selected', { count: chosen.length }) : t('noneSelected')}</span>
      {chosen.length > 0 && counts.gate > 0 && result !== 'feedback' && <span className="text-sm text-amber-700 dark:text-amber-400">{t('gate', { count: counts.gate })}</span>}
      <span className="ms-auto flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={pending || !counts.n1 || result === 'feedback'} onClick={() => setDialog({ kind: 'leaders', rows: chosen })}>{counts.n1 ? t('toLeadersCount', { count: counts.n1 }) : t('toLeaders')}</Button>
        <Button type="button" disabled={pending || !(counts.n2 || counts.gate)} onClick={() => setDialog({ kind: 'employees', rows: chosen })}>{counts.n2 ? t('toEmployeesCount', { count: counts.n2 }) : t('toEmployees')}</Button>
        <span className="relative">
          <Button ref={revokeRef} type="button" variant="ghost" disabled={pending || !chosen.length} aria-haspopup="menu" aria-expanded={menu} aria-controls="release-revoke-menu" onClick={() => setMenu((m) => !m)}>{t('revoke')} ▾</Button>
          {menu && <div id="release-revoke-menu" role="menu" className="absolute bottom-full right-0 z-20 mb-1 min-w-56 rounded-md border border-border bg-popover p-1 shadow-md"
            onKeyDown={(e) => { if (e.key === 'Escape') { setMenu(false); revokeRef.current?.focus(); } }}>
            {(['revokeEmployees', 'revokeBoth'] as const).map((k) => <button key={k} type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => { setMenu(false); setDialog({ kind: k, rows: chosen }); }}>{t(k)}</button>)}
          </div>}
        </span>
      </span>
    </div>
    <AlertDialog.Root open={!!dialog} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-3 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          {body && <>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{body.kicker}</p>
            <AlertDialog.Title className="text-base font-semibold">{body.title}</AlertDialog.Title>
            <AlertDialog.Description asChild><div className="space-y-3">{body.content}</div></AlertDialog.Description>
            <div className="flex justify-end gap-2 pt-2">
              <AlertDialog.Cancel asChild><Button type="button" variant="outline" size="sm">{t('dialog.cancel')}</Button></AlertDialog.Cancel>
              <AlertDialog.Action asChild><Button type="button" size="sm" variant={body.danger ? 'destructive' : 'default'} disabled={body.off || pending} onClick={confirm}>{pending ? t('dialog.working') : body.confirm}</Button></AlertDialog.Action>
            </div>
          </>}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </section>;
}
