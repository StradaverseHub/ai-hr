'use client';
/**
 * WP-E (CF-08) — "What you led": the people a leader is over, one tab per seat, each with what release 1 lets
 * the leader read now. Opening a person shows both bands step by step with each tier's reason, cut at the
 * leader's own step until HR releases the results to leaders. Every value here was already cut by the database
 * (app.onehr_leader_result); this component only filters and lays it out.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import type { listOnehrLedPeople } from '@/packs/performance/service';

type Data = Awaited<ReturnType<typeof listOnehrLedPeople>>;
type Person = Data['people'][number];
const PAGE = 50;
const BANDS = { performance: ['UA', 'BE', 'ME', 'AE', 'OU'], potential: ['Low', 'Mid', 'High'] } as const;
const TALENT_ORDER = ['Super Star', 'Star', 'Solid Core', 'PIP/Improvement'];
const day = (iso: string | null) => (iso ? todayInKualaLumpur(new Date(iso)) : '');

export function LedPeople({ data }: { data: Data }) {
  const t = useTranslations('onehr.led');
  const router = useRouter();
  const [q, setQ] = useState(''), [band, setBand] = useState(''), [moved, setMoved] = useState(false), [talent, setTalent] = useState(''), [row, setRow] = useState('');
  const [shown, setShown] = useState(PAGE), [open, setOpen] = useState<Set<string>>(new Set());
  const href = (cycle: string | undefined, tab: string | null) => `/performance/led?${new URLSearchParams(Object.entries({ cycle: cycle ?? '', tab: tab ?? '' }).filter((e) => !!e[1]))}`;
  const inRow = useMemo(() => data.people.filter((p) => !row || !data.filter || p[data.filter.key] === row), [data, row]);
  const rows = useMemo(() => inRow.filter((p) => {
    const text = q.trim().toLowerCase();
    if (text && !`${p.name} ${p.department ?? ''}`.toLowerCase().includes(text)) return false;
    if (band && p.summary.performance !== band && p.summary.potential !== band) return false;
    if (moved && !p.summary.moves) return false;
    if (talent && p.summary.talent !== talent) return false;
    return true;
  }), [inRow, q, band, moved, talent]);
  const tally = useMemo(() => { const m = new Map<string, number>(); for (const p of inRow) if (p.summary.talent) m.set(p.summary.talent, (m.get(p.summary.talent) ?? 0) + 1); return TALENT_ORDER.filter((c) => m.get(c)).map((c) => ({ name: c, n: m.get(c)! })); }, [inRow]);
  if (!data.cycle) return <p className="rounded-md border border-border p-5 text-sm text-muted-foreground">{t('none')}</p>;
  const sub = data.atOnce ? t('subAtOnce') : data.state === 'before' ? t('subBefore') : data.state === 'mixed' ? t('subMixed', { full: data.nFull, total: data.nRes || data.people.length }) : t('subAfter');
  const you = (label: string) => (data.atOnce || data.state === 'after' ? label : t('yours', { label }));
  const toggle = (id: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{sub}</p>
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex items-center gap-2 text-sm">{t('cycle')}
        <select aria-label={t('cycle')} className={`${inputCls} w-auto`} value={data.cycle.id} onChange={(e) => router.push(href(e.target.value, data.tab))}>
          {data.cycles.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status !== 'closed' ? ` · ${t('current')}` : ''}</option>)}
        </select></label>
    </div>
    <nav aria-label={t('tabsLabel')} className="flex flex-wrap gap-2 border-b border-border pb-2">
      {data.tabs.map((tab) => <Link key={tab.key} href={href(data.cycle?.id, tab.key)} aria-current={tab.key === data.tab ? 'page' : undefined}
        className={`rounded-md px-3 py-1.5 text-sm ${tab.key === data.tab ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent'}`}>{t('tab', { label: t(`tabs.${tab.key}`), count: tab.n })}</Link>)}
    </nav>
    {data.filter && data.filter.items.length > 1 && <div role="group" aria-label={data.filter.key === 'company' ? t('filterCompany') : t('filterDepartment')} className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{data.filter.key === 'company' ? t('filterCompany') : t('filterDepartment')}</span>
      {[{ value: '', n: data.people.length }, ...data.filter.items].map((it) => <button key={it.value || 'all'} type="button" aria-pressed={row === it.value}
        className={`rounded-full border px-3 py-1 text-xs ${row === it.value ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`} onClick={() => { setRow(it.value); setTalent(''); setShown(PAGE); }}>{it.value || t('all')} <b>{it.n}</b></button>)}
    </div>}
    {tally.length > 0 && <div role="group" aria-label={t('talentFilter')} className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{t('talentFilter')}</span>
      {tally.map((c) => <button key={c.name} type="button" aria-pressed={talent === c.name} className={`rounded-full border px-3 py-1 text-xs ${talent === c.name ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}
        onClick={() => { setTalent(talent === c.name ? '' : c.name); setShown(PAGE); }}>{c.name} <b>{c.n}</b></button>)}</div>}
    <div className="flex flex-wrap items-center gap-4">
      <input type="search" aria-label={t('search')} placeholder={t('search')} value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} className={`${inputCls} max-w-xs`}/>
      <label className="flex items-center gap-2 text-sm">{t('finalBand')}
        <select aria-label={t('finalBand')} value={band} onChange={(e) => { setBand(e.target.value); setShown(PAGE); }} className={`${inputCls} w-auto`}>
          <option value="">{t('any')}</option>
          {(['performance', 'potential'] as const).map((axis) => <optgroup key={axis} label={t(`axis.${axis}`)}>{BANDS[axis].map((b) => <option key={b} value={b}>{b}</option>)}</optgroup>)}
        </select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={moved} onChange={(e) => { setMoved(e.target.checked); setShown(PAGE); }}/>{t('movedOnly')}</label>
      <span aria-live="polite" className="text-sm text-muted-foreground">{t('shown', { shown: rows.length, total: data.people.length })}</span>
    </div>
    {data.state !== 'after' && !data.atOnce && <p role="note" className="rounded-md border border-amber-300 bg-amber-50/60 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
      <b>{data.state === 'before' ? t('noteBefore') : t('noteMixed')}</b> {t('noteHelp')}</p>}
    <div className="overflow-x-auto rounded-md border border-border">
      <div role="table" aria-label={t('title')} className="min-w-[720px]">
        <div role="row" className="grid grid-cols-[2fr_1.2fr_1fr_1fr_1.2fr_2.5rem] gap-3 bg-muted/40 p-3 text-xs font-medium">
          <span role="columnheader">{t('person')}</span><span role="columnheader">{t('talent')}</span><span role="columnheader">{you(t('performance'))}</span><span role="columnheader">{you(t('potential'))}</span><span role="columnheader">{t('moved')}</span><span role="columnheader"/>
        </div>
        {rows.slice(0, shown).map((p) => <LedRow key={p.reviewId} p={p} open={open.has(p.reviewId)} onToggle={() => toggle(p.reviewId)}/>)}
        {!rows.length && <p className="p-5 text-sm text-muted-foreground">{data.people.length ? t('noMatch') : t('nobody')}</p>}
      </div>
    </div>
    {rows.length > PAGE && <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted-foreground">{t('showing', { shown: Math.min(shown, rows.length), total: rows.length })}</span>
      {rows.length > shown && <button type="button" className="text-primary hover:underline" onClick={() => setShown(shown + PAGE)}>{t('more', { count: Math.min(PAGE, rows.length - shown) })}</button>}
      {shown > PAGE && <button type="button" className="text-primary hover:underline" onClick={() => setShown(PAGE)}>{t('less')}</button>}
    </div>}
  </div>;
}

function LedRow({ p, open, onToggle }: { p: Person; open: boolean; onToggle: () => void }) {
  const t = useTranslations('onehr.led');
  const meta = [p.department, p.grade ? p.grade : null].filter(Boolean).join(' · ');
  const tone = p.release.tone === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : p.release.tone === 'you' ? 'text-blue-700 dark:text-blue-400' : 'text-muted-foreground';
  const movedText = p.summary.full ? (p.summary.moves ? t('moves', { count: p.summary.moves }) : t('noMoves'))
    : p.summary.you.length ? t('youMoved', { axis: p.summary.you.length === 2 ? t('both') : t(`axis.${p.summary.you[0]}`).toLowerCase() }) : p.summary.none ? '' : t('noMovesByYou');
  const panel = `led-chain-${p.reviewId}`;
  return <div role="rowgroup" className="border-t border-border">
    <div role="row" className="grid grid-cols-[2fr_1.2fr_1fr_1fr_1.2fr_2.5rem] items-center gap-3 p-3 text-sm">
      <span role="cell"><b>{p.name}</b>{meta && <span className="block text-xs text-muted-foreground">{meta}</span>}<span className={`block text-xs ${tone}`}>{t(`release.${p.release.key}`, { date: day(p.release.at) })}</span></span>
      <span role="cell">{p.summary.talent ? <b>{p.summary.talent}</b> : <span className="text-muted-foreground">{p.summary.none ? t('noResult') : p.midYear ? t('withHod') : t('inCalibration')}</span>}</span>
      <span role="cell" translate="no">{p.summary.performance ?? '—'}</span>
      <span role="cell" translate="no">{p.summary.potential ?? '—'}</span>
      <span role="cell" className={p.summary.moves ? 'font-medium' : 'text-muted-foreground'}>{movedText}</span>
      <span role="cell"><button type="button" aria-expanded={open} aria-controls={panel} aria-label={t('toggle', { name: p.name })} className="rounded px-2 py-1 hover:bg-accent" onClick={onToggle}>{open ? '▾' : '▸'}</button></span>
    </div>
    {open && <div id={panel} className="space-y-3 bg-muted/20 px-3 pb-4 pt-1"><LedChain p={p}/></div>}
  </div>;
}

function LedChain({ p }: { p: Person }) {
  const t = useTranslations('onehr.led');
  const axes = p.axes.filter((a) => a.steps.length);
  if (!axes.length) return <p className="text-sm text-muted-foreground">{t('nothing')}</p>;
  const cols = [...new Set(axes.flatMap((a) => a.steps.map((s) => s.tier)))];
  const label = (tier: string) => { const s = axes.flatMap((a) => a.steps).find((x) => x.tier === tier); const base = t(`steps.${tier}`); return s?.you ? t('stepYou', { label: base }) : base; };
  const anyFull = axes.some((a) => a.full);
  const reasons = axes.flatMap((a) => { let before: string | null = null; return a.steps.flatMap((s) => {
    const out = s.state !== 'hidden' && s.why && s.band ? [{ key: `${a.axis}.${s.tier}`, who: label(s.tier), what: s.state === 'moved' && before ? t('whyMoved', { axis: t(`axis.${a.axis}`), from: before, to: s.band }) : s.state === 'kept' ? t('whyKept', { axis: t(`axis.${a.axis}`), band: s.band }) : t('whySet', { axis: t(`axis.${a.axis}`), band: s.band }), why: s.why }] : [];
    before = s.band ?? before; return out; }); });
  return <>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead><tr><th className="p-2"/>{cols.map((c) => <th key={c} className="whitespace-nowrap p-2 text-xs font-medium text-muted-foreground">{label(c)}</th>)}<th className="p-2 text-xs font-medium text-muted-foreground">{t('final')}</th></tr></thead>
      <tbody>{axes.map((a) => <tr key={a.axis} className="border-t border-border">
        <th scope="row" className="p-2 text-xs font-medium">{t(`axis.${a.axis}`)}</th>
        {cols.map((c) => { const s = a.steps.find((x) => x.tier === c); return <td key={c} className="p-2">
          {!s ? <span className="text-muted-foreground">—</span> : s.state === 'hidden' ? <span className="text-xs text-muted-foreground">{p.midYear ? t('hiddenMid') : t('hidden')}</span>
            : !s.band ? <span className="text-muted-foreground">—</span>
            : <span className="flex flex-col"><b translate="no">{s.band}</b>{s.state === 'moved' ? <span className="text-xs text-blue-700 dark:text-blue-400">{s.dir === 'up' ? t('up') : s.dir === 'down' ? t('down') : ''}</span> : s.state === 'kept' ? <span className="text-xs text-muted-foreground">{t('kept')}</span> : null}</span>}
        </td>; })}
        <td className="p-2">{a.full && a.final ? <b translate="no">{a.final}</b> : <span className="text-xs text-muted-foreground">{a.full ? '—' : p.midYear ? t('notReleased') : t('hidden')}</span>}</td>
      </tr>)}</tbody>
    </table></div>
    {reasons.length > 0 && <dl className="space-y-2 text-sm">{reasons.map((r) => <div key={r.key}><dt className="text-xs font-medium text-muted-foreground">{r.who}</dt><dd><b>{r.what}</b> “{r.why}”</dd></div>)}</dl>}
    {!anyFull && <p className="text-xs text-muted-foreground">{t('afterYours')}</p>}
  </>;
}
