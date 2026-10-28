'use client';
/**
 * WP-B2 — the Leaders screen: HODs (by HOD and by department), BU CEOs, BG CEOs and group chiefs.
 *
 * Every write goes through ./actions, which calls the leader seat service as the viewer; the service and
 * RLS decide. The capability flags in `data` (from the database's writer functions) only decide which
 * controls are drawn. An HOD change is always previewed first: Apply sends the preview's fingerprint, needs
 * every warning ticked, and needs an override reason while anything blocks.
 */
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { Segmented } from '@/components/ui/segmented';
import { EmployeeSearchField, type EmployeeSearchOption } from '@/components/employee-search-field';
import { employeeLabel } from '@/lib/employee-code';
import {
  addCalibrationGroupMembersAction, appointLeaderSeatAction, applyHodChangeAction, calibrationGroupMembersAction, createCalibrationGroupAction,
  endCalibrationGroupMemberAction, endLeaderSeatAction, previewHodChangeAction, renameCalibrationGroupAction,
} from './actions';
import { departmentRows, hodCards, inCompany, type GroupMemberView, type HodPreviewView, type LeaderSeatKind, type LeadersData, type LeadersSeat } from './model';

type Tab = 'hod' | 'bu' | 'bg';
const TABS: Tab[] = ['hod', 'bu', 'bg'];
const tdCls = 'px-3 py-2 align-top';

function usePeople(data: LeadersData) {
  return useMemo(() => {
    const byId = new Map(data.people.map((p) => [p.employmentId, p]));
    const companyName = new Map(data.companies.map((c) => [c.id, c.name]));
    const options: EmployeeSearchOption[] = data.people.map((p) => ({
      value: p.employmentId, name: p.name ?? p.employeeCode ?? '', employeeCode: p.employeeCode,
      secondary: [companyName.get(p.companyId), p.departmentName].filter(Boolean).join(' · ') || null,
    }));
    const label = (id: string, fallback?: string | null) => { const p = byId.get(id); return p ? employeeLabel(p.employeeCode, p.name ?? '') : fallback ?? id; };
    return { byId, options, label };
  }, [data]);
}

function PersonPicker({ options, onChange, id }: { options: EmployeeSearchOption[]; onChange: (v: string) => void; id?: string }) {
  const t = useTranslations('onehr.leaders');
  return <EmployeeSearchField id={id} employees={options} onValueChange={onChange}
    labels={{ placeholder: t('search.placeholder'), ariaLabel: t('search.ariaLabel'), resultsLabel: t('search.results'), noMatches: t('search.noMatches'), clear: t('search.clear') }} />;
}

function Alert({ text }: { text: string }) {
  return text ? <p role="alert" className="text-sm text-destructive">{text}</p> : null;
}

export function LeadersAdmin({ data, initialTab = 'hod' }: { data: LeadersData; initialTab?: Tab }) {
  const t = useTranslations('onehr.leaders');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [company, setCompany] = useState('');
  const readOnly = !data.canWriteHod && !data.canWriteGroupChief && !data.companies.some((c) => c.canWriteBuCeo || c.canWriteBgCeo);
  return (
    <div className="space-y-4">
      {readOnly && <p className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">{t('readOnly')}</p>}
      <div role="tablist" aria-label={t('tabs.label')} className="flex overflow-x-auto border-b border-border">
        {TABS.map((key) => (
          <button key={key} type="button" role="tab" id={`leaders-tab-${key}`} aria-controls={`leaders-panel-${key}`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
            onKeyDown={(e) => { const i = TABS.indexOf(key); const next = e.key === 'ArrowRight' ? TABS[(i + 1) % 3] : e.key === 'ArrowLeft' ? TABS[(i + 2) % 3] : null; if (next) { e.preventDefault(); setTab(next); document.getElementById(`leaders-tab-${next}`)?.focus(); } }}
            className={`min-h-11 shrink-0 border-b-2 px-4 text-sm ${tab === key ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground'}`}>
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>
      {tab !== 'bg' && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('companyFilter')} className="w-full sm:w-72">
            <select value={company} onChange={(e) => setCompany(e.target.value)} className={inputCls}>
              <option value="">{t('allCompanies')}</option>
              {data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      <section role="tabpanel" id={`leaders-panel-${tab}`} aria-labelledby={`leaders-tab-${tab}`}>
        {tab === 'hod' && <HodTab data={data} company={company} />}
        {tab === 'bu' && <BuTab data={data} company={company} />}
        {tab === 'bg' && <BgTab data={data} />}
      </section>
    </div>
  );
}

// ── HODs ────────────────────────────────────────────────────────────────────────────────────────────────

type Change = { subjectEmploymentIds: string[]; hodEmploymentId: string | null };

function HodTab({ data, company }: { data: LeadersData; company: string }) {
  const t = useTranslations('onehr.leaders');
  const [view, setView] = useState<'byHod' | 'byDepartment'>('byHod');
  const [change, setChange] = useState<Change | null>(null);
  const [notice, setNotice] = useState('');
  return (
    <div className="space-y-4">
      <Segmented label={t('viewLabel')} value={view} onChange={setView} options={[{ value: 'byHod', label: t('byHod') }, { value: 'byDepartment', label: t('byDepartment') }]} />
      {notice && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
      {change && <HodPreview data={data} change={change} onClose={() => setChange(null)} onApplied={(n) => { setChange(null); setNotice(t('applied', { count: n })); }} />}
      {view === 'byHod' ? <ByHod data={data} company={company} onPreview={(c) => { setNotice(''); setChange(c); }} /> : <ByDepartment data={data} company={company} onPreview={(c) => { setNotice(''); setChange(c); }} />}
    </div>
  );
}

function ByHod({ data, company, onPreview }: { data: LeadersData; company: string; onPreview: (c: Change) => void }) {
  const t = useTranslations('onehr.leaders');
  const cards = hodCards(data, company);
  const [open, setOpen] = useState<string | null>(null);
  if (!cards.length) return <p className="text-sm text-muted-foreground">{t('noHods')}</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <Card key={card.hodEmploymentId} className="min-w-0 space-y-3 p-4">
          <div className="min-w-0">
            <h3 className="font-medium [overflow-wrap:anywhere]">{employeeLabel(card.employeeCode, card.name ?? '')}</h3>
            <p className="text-sm text-muted-foreground">{t('peopleCount', { count: card.people.length })}</p>
          </div>
          {data.canWriteHod && (open === card.hodEmploymentId
            ? <HodManage data={data} people={card.people} hodEmploymentId={card.hodEmploymentId} onPreview={onPreview} onClose={() => setOpen(null)} />
            : <Button type="button" size="sm" variant="outline" onClick={() => setOpen(card.hodEmploymentId)}>{t('manage')}</Button>)}
        </Card>
      ))}
    </div>
  );
}

function HodManage({ data, people, hodEmploymentId, onPreview, onClose }: { data: LeadersData; people: string[]; hodEmploymentId: string; onPreview: (c: Change) => void; onClose: () => void }) {
  const t = useTranslations('onehr.leaders');
  const { options, label } = usePeople(data);
  const [picked, setPicked] = useState<Set<string>>(new Set(people));
  const [next, setNext] = useState('');
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <fieldset className="max-h-48 space-y-1 overflow-y-auto">
        <legend className="mb-1 text-sm font-medium">{t('selectPeople')}</legend>
        {people.map((id) => <label key={id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={picked.has(id)} onChange={() => toggle(id)} />{label(id)}</label>)}
      </fieldset>
      <div className="space-y-1"><span className="text-sm font-medium">{t('newHod')}</span><PersonPicker options={options.filter((o) => o.value !== hodEmploymentId)} onChange={setNext} /></div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!next || picked.size === 0} onClick={() => onPreview({ subjectEmploymentIds: [...picked], hodEmploymentId: next })}>{t('changeHodSelected')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onPreview({ subjectEmploymentIds: people, hodEmploymentId: null })}>{t('removeAsHod')}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

function ByDepartment({ data, company, onPreview }: { data: LeadersData; company: string; onPreview: (c: Change) => void }) {
  const t = useTranslations('onehr.leaders');
  const { options } = usePeople(data);
  const rows = departmentRows(data, company);
  const [open, setOpen] = useState<string | null>(null);
  const [next, setNext] = useState('');
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t('noPeople')}</p>;
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className={tableWrapCls}>
        <table className="w-full min-w-[40rem] text-sm">
          <thead className={theadCls}><tr><th className={thCls}>{t('colDepartment')}</th><th className={thCls}>{t('colCompany')}</th><th className={`${thCls} text-right`}>{t('colPeople')}</th><th className={thCls}>{t('colHod')}</th>{data.canWriteHod && <th className={thCls}><span className="sr-only">{t('colAction')}</span></th>}</tr></thead>
          <tbody className={tbodyCls}>
            {rows.map((r) => {
              const hods = [...r.hods.entries()];
              const hodText = hods.length === 0 ? t('noHod') : hods.length === 1 && r.withoutHod === 0 ? hods[0][1] ?? t('noHod') : t('mixedHods', { count: hods.length });
              return [
                <tr key={r.key}>
                  <td className={tdCls}>{r.departmentName ?? t('noDepartment')}</td>
                  <td className={tdCls}>{r.companyName}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{r.people.length}</td>
                  <td className={tdCls}>{hodText}</td>
                  {data.canWriteHod && <td className={`${tdCls} text-right`}><Button type="button" size="sm" variant="outline" onClick={() => { setNext(''); setOpen(open === r.key ? null : r.key); }}>{hods.length ? t('change') : t('assign')}</Button></td>}
                </tr>,
                open === r.key && (
                  <tr key={`${r.key}-panel`}><td colSpan={5} className="bg-muted/30 px-3 py-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="w-full space-y-1 sm:w-80"><span className="text-sm font-medium">{t('newHod')}</span><PersonPicker options={options} onChange={setNext} /></div>
                      <Button type="button" size="sm" disabled={!next} onClick={() => { setOpen(null); onPreview({ subjectEmploymentIds: r.people, hodEmploymentId: next }); }}>{t('preview')}</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(null)}>{t('cancel')}</Button>
                    </div>
                  </td></tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function HodPreview({ data, change, onClose, onApplied }: { data: LeadersData; change: Change; onClose: () => void; onApplied: (changed: number) => void }) {
  const t = useTranslations('onehr.leaders');
  const router = useRouter();
  const { label } = usePeople(data);
  const [preview, setPreview] = useState<HodPreviewView | null>(null);
  const [error, setError] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [pending, start] = useTransition();
  const key = JSON.stringify(change);
  useEffect(() => {
    let live = true;
    setPreview(null); setError(''); setTicked(new Set()); setReason('');
    void previewHodChangeAction(JSON.parse(key) as Change).then((r) => { if (!live) return; if ('error' in r) setError(r.error); else setPreview(r.data); });
    return () => { live = false; };
  }, [key]);
  const nameOf = (id: string) => { const row = preview?.rows.find((r) => r.subjectEmploymentId === id); return row ? employeeLabel(row.subjectEmployeeCode, row.subjectName ?? '') : label(id); };
  const blocked = !!preview && preview.blockers.length > 0;
  const allTicked = !!preview && preview.warnings.every((w) => ticked.has(w.code));
  const canApply = !!preview && preview.rows.length > 0 && allTicked && (!blocked || reason.trim().length > 0) && !pending;
  const apply = () => start(async () => {
    if (!preview) return;
    const r = await applyHodChangeAction({ ...change, fingerprint: preview.fingerprint, acknowledged: preview.warnings.length > 0 && allTicked, overrideReason: blocked ? reason : undefined });
    if ('error' in r) { setError(r.error); return; }
    router.refresh();
    onApplied(r.data.changed);
  });
  return (
    <Card className="min-w-0 space-y-4 p-4" aria-label={t('previewTitle')} role="region">
      <h3 className="font-semibold">{t('previewTitle')}</h3>
      <Alert text={error} />
      {!preview && !error && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
      {preview && <>
        {preview.rows.length === 0 ? <p className="text-sm">{t('noChanges')}</p> : (
          <div className={tableWrapCls}>
            <table className="w-full min-w-[40rem] text-sm">
              <thead className={theadCls}><tr>{(['colPerson', 'colCompany', 'colDepartment', 'colHodNow', 'colBecomes'] as const).map((k) => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead>
              <tbody className={tbodyCls}>{preview.rows.map((r) => <tr key={r.subjectEmploymentId}>
                <td className={tdCls}>{employeeLabel(r.subjectEmployeeCode, r.subjectName ?? '')}</td><td className={tdCls}>{r.companyName ?? ''}</td><td className={tdCls}>{r.departmentName ?? t('noDepartment')}</td>
                <td className={tdCls}>{r.currentHodName ?? t('noHod')}</td><td className={`${tdCls} font-medium`}>{r.nextHodName ?? t('noHod')}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
        {(preview.unchanged > 0 || preview.selfExcluded > 0) && <p className="text-sm text-muted-foreground">{preview.unchanged > 0 && t('unchangedNote', { count: preview.unchanged })} {preview.selfExcluded > 0 && t('selfNote', { count: preview.selfExcluded })}</p>}
        {blocked && (
          <div className="space-y-2 rounded-md border border-destructive/40 p-3">
            <h4 className="text-sm font-medium text-destructive">{t('blockersTitle')}</h4>
            <ul className="list-disc space-y-1 pl-5 text-sm">{preview.blockers.map((b) => <li key={b.code}>{t(`blockers.${b.code}`)} <span className="text-muted-foreground">{t('concerns', { names: b.employmentIds.map(nameOf).join(', ') })}</span></li>)}</ul>
            <Field label={t('overrideReason')}><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} className={inputCls} /></Field>
            <p className="text-xs text-muted-foreground">{t('overrideHelp')}</p>
          </div>
        )}
        {preview.warnings.length > 0 && (
          <div className="space-y-2 rounded-md border border-amber-500/40 p-3">
            <h4 className="text-sm font-medium">{t('warningsTitle')}</h4>
            <ul className="space-y-3 text-sm">{preview.warnings.map((w) => <li key={w.code} className="space-y-1">
              <p>{t(`warnings.${w.code}`)} <span className="text-muted-foreground">{t('concerns', { names: w.employmentIds.map(nameOf).join(', ') })}</span></p>
              <label className="flex min-h-9 items-center gap-2"><input type="checkbox" checked={ticked.has(w.code)} onChange={() => setTicked((s) => { const n = new Set(s); if (n.has(w.code)) n.delete(w.code); else n.add(w.code); return n; })} />{t('readIt')}</label>
            </li>)}</ul>
          </div>
        )}
      </>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canApply} onClick={apply}>{t('apply')}</Button>
        <Button type="button" variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </Card>
  );
}

// ── Seats (BU CEO, BG CEO, group chief) ─────────────────────────────────────────────────────────────────

function SeatPanel({ data, seat, seatType, companyId, calibrationGroupId, onDone }: { data: LeadersData; seat: LeadersSeat | undefined; seatType: LeaderSeatKind; companyId: string | null; calibrationGroupId: string | null; onDone: () => void }) {
  const t = useTranslations('onehr.leaders');
  const router = useRouter();
  const { options } = usePeople(data);
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await appointLeaderSeatAction({ seatType, companyId, calibrationGroupId, holderEmploymentId: next });
    if ('error' in r) { setError(r.error); return; }
    setError(''); setNotice(r.data.unchanged ? t('seatUnchanged') : t('seatSaved')); router.refresh();
  });
  const end = () => start(async () => {
    if (!seat) return;
    const r = await endLeaderSeatAction(seat.id);
    if ('error' in r) { setError(r.error); return; }
    setError(''); setNotice(t('seatEnded')); router.refresh();
  });
  return (
    <div className="space-y-3">
      <p className="text-sm"><span className="text-muted-foreground">{t('now')}: </span>{seat ? employeeLabel(seat.holderEmployeeCode, seat.holderName ?? '') : t('vacant')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full space-y-1 sm:w-80"><span className="text-sm font-medium">{t('changeTo')}</span><PersonPicker options={options} onChange={setNext} /></div>
        <Button type="button" size="sm" disabled={!next || pending} onClick={save}>{t('save')}</Button>
        {seat && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={end}>{t('endSeat')}</Button>}
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>{t('cancel')}</Button>
      </div>
      <Alert text={error} />
      {notice && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
    </div>
  );
}

function holderText(seat: LeadersSeat | undefined, vacant: string) {
  return seat ? employeeLabel(seat.holderEmployeeCode, seat.holderName ?? '') : vacant;
}

function BuTab({ data, company }: { data: LeadersData; company: string }) {
  const t = useTranslations('onehr.leaders');
  const [open, setOpen] = useState<string | null>(null);
  const units = data.companies.filter((c) => !c.isGroupNode && inCompany(company, c.id, data.companies));
  const writable = units.some((c) => c.canWriteBuCeo);
  if (!units.length) return <p className="text-sm text-muted-foreground">{t('noUnits')}</p>;
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className={tableWrapCls}>
        <table className="w-full min-w-[36rem] text-sm">
          <thead className={theadCls}><tr><th className={thCls}>{t('colCompany')}</th><th className={`${thCls} text-right`}>{t('colPeople')}</th><th className={thCls}>{t('buCeo')}</th>{writable && <th className={thCls}><span className="sr-only">{t('colAction')}</span></th>}</tr></thead>
          <tbody className={tbodyCls}>
            {units.map((c) => {
              const seat = data.seats.find((s) => s.seatType === 'bu_ceo' && s.companyId === c.id);
              return [
                <tr key={c.id}>
                  <td className={tdCls}>{c.name}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{data.people.filter((p) => p.companyId === c.id).length}</td>
                  <td className={tdCls}>{holderText(seat, t('vacant'))}</td>
                  {writable && <td className={`${tdCls} text-right`}>{c.canWriteBuCeo && <Button type="button" size="sm" variant="outline" aria-label={t('changeFor', { name: c.name })} onClick={() => setOpen(open === c.id ? null : c.id)}>{t('change')}</Button>}</td>}
                </tr>,
                open === c.id && <tr key={`${c.id}-panel`}><td colSpan={4} className="bg-muted/30 px-3 py-3"><SeatPanel data={data} seat={seat} seatType="bu_ceo" companyId={c.id} calibrationGroupId={null} onDone={() => setOpen(null)} /></td></tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function BgTab({ data }: { data: LeadersData }) {
  const t = useTranslations('onehr.leaders');
  const [open, setOpen] = useState<string | null>(null);
  const nodes = data.companies.filter((c) => c.isGroupNode);
  const writable = nodes.some((c) => c.canWriteBgCeo);
  return (
    <div className="space-y-6">
      {nodes.length === 0 ? <p className="text-sm text-muted-foreground">{t('noGroupNodes')}</p> : (
        <Card className="min-w-0 overflow-hidden">
          <div className={tableWrapCls}>
            <table className="w-full min-w-[30rem] text-sm">
              <thead className={theadCls}><tr><th className={thCls}>{t('colGroupNode')}</th><th className={thCls}>{t('bgCeo')}</th>{writable && <th className={thCls}><span className="sr-only">{t('colAction')}</span></th>}</tr></thead>
              <tbody className={tbodyCls}>
                {nodes.map((c) => {
                  const seat = data.seats.find((s) => s.seatType === 'bg_ceo' && s.companyId === c.id);
                  return [
                    <tr key={c.id}>
                      <td className={tdCls}>{c.name}</td>
                      <td className={tdCls}>{holderText(seat, t('vacant'))}</td>
                      {writable && <td className={`${tdCls} text-right`}>{c.canWriteBgCeo && <Button type="button" size="sm" variant="outline" aria-label={t('changeFor', { name: c.name })} onClick={() => setOpen(open === c.id ? null : c.id)}>{t('change')}</Button>}</td>}
                    </tr>,
                    open === c.id && <tr key={`${c.id}-panel`}><td colSpan={3} className="bg-muted/30 px-3 py-3"><SeatPanel data={data} seat={seat} seatType="bg_ceo" companyId={c.id} calibrationGroupId={null} onDone={() => setOpen(null)} /></td></tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <GroupChiefs data={data} />
    </div>
  );
}

function GroupChiefs({ data }: { data: LeadersData }) {
  const t = useTranslations('onehr.leaders');
  const router = useRouter();
  const [open, setOpen] = useState<{ id: string; kind: 'chief' | 'members' } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const writable = data.canWriteGroupChief || data.canWriteHod;
  const create = () => start(async () => {
    const r = await createCalibrationGroupAction(name);
    if ('error' in r) { setError(r.error); return; }
    setError(''); setName(''); router.refresh();
  });
  return (
    <Card className="min-w-0 space-y-3 overflow-hidden p-4">
      <h3 className="font-semibold">{t('groupsTitle')}</h3>
      {data.groups.length === 0 ? <p className="text-sm text-muted-foreground">{t('noGroups')}</p> : (
        <div className={tableWrapCls}>
          <table className="w-full min-w-[34rem] text-sm">
            <thead className={theadCls}><tr><th className={thCls}>{t('colGroup')}</th><th className={`${thCls} text-right`}>{t('colMembers')}</th><th className={thCls}>{t('colChief')}</th>{writable && <th className={thCls}><span className="sr-only">{t('colAction')}</span></th>}</tr></thead>
            <tbody className={tbodyCls}>
              {data.groups.map((g) => {
                const seat = data.seats.find((s) => s.seatType === 'group_chief' && s.calibrationGroupId === g.id);
                return [
                  <tr key={g.id}>
                    <td className={tdCls}>{g.name}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{g.members}</td>
                    <td className={tdCls}>{seat ? holderText(seat, t('vacant')) : g.chief?.name ?? t('vacant')}</td>
                    {writable && <td className={`${tdCls} text-right`}><div className="flex flex-wrap justify-end gap-2">
                      {data.canWriteGroupChief && <Button type="button" size="sm" variant="outline" aria-label={t('changeFor', { name: g.name })} onClick={() => setOpen(open?.id === g.id && open.kind === 'chief' ? null : { id: g.id, kind: 'chief' })}>{t('change')}</Button>}
                      {data.canWriteHod && <Button type="button" size="sm" variant="outline" onClick={() => setOpen(open?.id === g.id && open.kind === 'members' ? null : { id: g.id, kind: 'members' })}>{t('editMembers')}</Button>}
                    </div></td>}
                  </tr>,
                  open?.id === g.id && <tr key={`${g.id}-panel`}><td colSpan={4} className="bg-muted/30 px-3 py-3">
                    {open.kind === 'chief'
                      ? <SeatPanel data={data} seat={seat} seatType="group_chief" companyId={null} calibrationGroupId={g.id} onDone={() => setOpen(null)} />
                      : <GroupMembers data={data} groupId={g.id} groupName={g.name} onDone={() => setOpen(null)} />}
                  </td></tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      {data.canWriteHod && (
        <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <Field label={t('groupName')} className="w-full sm:w-80"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={inputCls} /></Field>
          <Button type="button" size="sm" disabled={!name.trim() || pending} onClick={create}>{t('createGroup')}</Button>
        </div>
      )}
      <Alert text={error} />
    </Card>
  );
}

function GroupMembers({ data, groupId, groupName, onDone }: { data: LeadersData; groupId: string; groupName: string; onDone: () => void }) {
  const t = useTranslations('onehr.leaders');
  const router = useRouter();
  const { options } = usePeople(data);
  const [members, setMembers] = useState<GroupMemberView[] | null>(null);
  const [error, setError] = useState('');
  const [next, setNext] = useState('');
  const [rename, setRename] = useState(groupName);
  const [pending, start] = useTransition();
  const load = () => calibrationGroupMembersAction(groupId).then((r) => { if ('error' in r) setError(r.error); else setMembers(r.data); });
  useEffect(() => {
    let live = true;
    void calibrationGroupMembersAction(groupId).then((r) => { if (!live) return; if ('error' in r) setError(r.error); else setMembers(r.data); });
    return () => { live = false; };
  }, [groupId]);
  const act = (body: () => Promise<{ error: string } | { ok: true; data: null }>) => start(async () => {
    const r = await body();
    if ('error' in r) { setError(r.error); return; }
    setError(''); await load(); router.refresh();
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('groupName')} className="w-full sm:w-80"><input value={rename} onChange={(e) => setRename(e.target.value)} maxLength={200} className={inputCls} /></Field>
        <Button type="button" size="sm" variant="outline" disabled={!rename.trim() || rename.trim() === groupName || pending} onClick={() => act(() => renameCalibrationGroupAction(groupId, rename))}>{t('rename')}</Button>
      </div>
      {members === null && !error && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
      {members && (members.length === 0 ? <p className="text-sm text-muted-foreground">{t('noMembers')}</p> : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {members.map((m) => <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="[overflow-wrap:anywhere]">{employeeLabel(m.employeeCode, m.name ?? '')}</span>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => act(() => endCalibrationGroupMemberAction(m.id))}>{t('removeMember')}</Button>
          </li>)}
        </ul>
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full space-y-1 sm:w-80"><span className="text-sm font-medium">{t('addMember')}</span><PersonPicker options={options.filter((o) => !members?.some((m) => m.employmentId === o.value))} onChange={setNext} /></div>
        <Button type="button" size="sm" disabled={!next || pending} onClick={() => act(() => addCalibrationGroupMembersAction(groupId, [next]))}>{t('add')}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>{t('cancel')}</Button>
      </div>
      <Alert text={error} />
    </div>
  );
}
