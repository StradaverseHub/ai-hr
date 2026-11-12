'use client';
import {useId,useRef,useState,useTransition,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {ChevronDown} from 'lucide-react';
import {AnchoredPanel,useAnchoredPanel} from '@/components/ui/anchored-panel';
import {isCalendarDate} from '@/lib/calendar-date';
import {personnelFilterHref} from '@/lib/personnel-list-controls';

/**
 * aa045103 — the Personnel list's header filters.
 *
 * NOT A SECOND FILTER MECHANISM. Each control edits one ORDINARY param the Filter dialog already owns
 * (companies, bu, dept, position, grade, type, bucket; joinedFrom/To, hiredFrom/To, confirmedFrom/To), so a
 * value chosen here shows in the dialog and as a chip, and a chip removed there clears it here: both read
 * the same URL. Choice values never enter the private criteria (one filter per field there, by design).
 *
 * Changes are staged in the panel and applied with Apply (or Clear); applying keeps every other param,
 * drops `page` and replaces the URL without a full page load. The panel is `position: fixed`
 * (components/ui/anchored-panel.tsx) because the table's overflow-x wrapper would clip an absolute one.
 *
 * EVERY PROP IS PLAIN DATA: the listing is a server component.
 */
type Option = {value: string; label: string};
const PANEL_WIDTH = 288;

function useApply(parameters: [string, string][], pageSize?: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return {pending, apply: (changes: Record<string, string[]>) => start(() =>
    router.replace(personnelFilterHref(parameters, changes, pageSize), {scroll: false}))};
}

function HeaderPanel({label, summary, active, pending, children, onOpen, open, setOpen}: {
  label: string; summary: string; active: boolean; pending: boolean; children: ReactNode;
  onOpen: () => void; open: boolean; setOpen: (open: boolean) => void;
}) {
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const {at, anchorTo, release} = useAnchoredPanel({open, onClose: () => { setOpen(false); release(); trigger.current?.focus(); }, width: PANEL_WIDTH, flipHeight: 380, align: 'start'});
  const toggle = () => {
    if (open) { setOpen(false); release(); return; }
    onOpen();
    if (trigger.current) anchorTo(trigger.current);
    setOpen(true);
  };
  return <>
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={label} aria-busy={pending} onClick={toggle}
      className={`flex min-h-9 w-full min-w-32 items-center justify-between gap-1 rounded-md border bg-background px-2 text-left font-normal ${active ? 'border-primary text-primary' : 'border-input text-foreground'}`}>
      <span className="truncate">{summary}</span><ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden/>
    </button>
    {open && at && typeof document !== 'undefined' && createPortal(<>
      {/* Click-away: a transparent layer under the panel. Closing discards the staged (unapplied) change. */}
      <div className="fixed inset-0 z-40" aria-hidden onMouseDown={() => { setOpen(false); release(); }}/>
      <AnchoredPanel at={at} id={panelId} role="dialog" aria-label={label}
        className="flex w-72 flex-col gap-2 text-sm font-normal text-popover-foreground">
        {children}
      </AnchoredPanel>
    </>, document.body)}
  </>;
}

/** Multi-select header filter for a column with predefined values. */
export function ColumnChoiceFilter({name, param, options, selected, blankLabel, parameters, pageSize}: {
  /** The column's translated name. */
  name: string;
  param: string;
  options: Option[];
  /** The applied values (from the URL). */
  selected: string[];
  /** Offered as an extra "Blank / unassigned" option when the field can be empty. */
  blankLabel?: string;
  parameters: [string, string][];
  pageSize?: string;
}) {
  const t = useTranslations('people.list.controls');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));
  const {pending, apply} = useApply(parameters, pageSize);
  const all = blankLabel ? [...options, {value: '__blank', label: blankLabel}] : options;
  const needle = search.trim().toLocaleLowerCase();
  const visible = needle ? all.filter(option => option.label.toLocaleLowerCase().includes(needle)) : all;
  const labels = selected.map(value => all.find(option => option.value === value)?.label ?? value);
  const joined = labels.join(', ');
  const summary = !selected.length ? t('choiceAll') : labels.length <= 3 && joined.length <= 28 ? joined : t('choiceSelected', {count: selected.length});
  const finish = (values: string[]) => { setOpen(false); apply({[param]: values}); };
  return <HeaderPanel label={t('filterColumn', {name})} summary={summary} active={selected.length > 0} pending={pending} open={open} setOpen={setOpen}
    onOpen={() => { setDraft(new Set(selected)); setSearch(''); }}>
    <input type="search" autoFocus value={search} onChange={event => setSearch(event.target.value)} aria-label={t('findOption', {name})}
      placeholder={t('findOption', {name})} maxLength={200} autoComplete="off" className="min-h-9 w-full rounded-md border border-input bg-background px-2"/>
    <div className="max-h-56 min-h-0 overflow-y-auto" role="group" aria-label={name}>
      {visible.length ? visible.map(option => <label key={option.value} className="flex min-h-9 items-start gap-2 py-1">
        <input type="checkbox" className="mt-0.5" checked={draft.has(option.value)} onChange={event => setDraft(previous => {
          const next = new Set(previous); if (event.target.checked) next.add(option.value); else next.delete(option.value); return next;
        })}/>
        <span className="min-w-0 break-words">{option.label}</span>
      </label>) : <p className="py-2 text-muted-foreground">{t('noOptions')}</p>}
    </div>
    <div className="flex items-center justify-between gap-2 border-t border-border pt-2 text-xs">
      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setDraft(previous => new Set([...previous, ...visible.map(option => option.value)]))}>{t('selectAllOptions')}</button>
      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setDraft(new Set())}>{t('clearSelection')}</button>
    </div>
    <div className="flex justify-end gap-2">
      <button type="button" className="min-h-9 rounded-md border border-border px-3" onClick={() => finish([])}>{t('clearChoice')}</button>
      <button type="button" className="min-h-9 rounded-md bg-primary px-3 text-primary-foreground" onClick={() => finish(all.filter(option => draft.has(option.value)).map(option => option.value))}>{t('applyChoice')}</button>
    </div>
  </HeaderPanel>;
}

/** From/To header filter for a date column (inclusive). */
export function ColumnDateRangeFilter({name, params, applied, parameters, pageSize}: {
  name: string;
  params: readonly [string, string];
  applied: {from?: string; to?: string};
  parameters: [string, string][];
  pageSize?: string;
}) {
  const t = useTranslations('people.list.controls');
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(applied.from ?? '');
  const [to, setTo] = useState(applied.to ?? '');
  const {pending, apply} = useApply(parameters, pageSize);
  const valid = (value: string) => !value || isCalendarDate(value);
  const ordered = !from || !to || from <= to;
  const summary = applied.from || applied.to ? `${applied.from ?? '…'} – ${applied.to ?? '…'}` : `${t('dateFrom')} – ${t('dateTo')}`;
  const finish = (next: {from: string; to: string}) => { setOpen(false); apply({[params[0]]: [next.from], [params[1]]: [next.to]}); };
  return <HeaderPanel label={t('filterColumn', {name})} summary={summary} active={!!(applied.from || applied.to)} pending={pending} open={open} setOpen={setOpen}
    onOpen={() => { setFrom(applied.from ?? ''); setTo(applied.to ?? ''); }}>
    <label className="flex flex-col gap-1 text-xs">{t('dateFrom')}
      <input type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} aria-label={t('dateFromLabel', {name})} className="min-h-9 rounded-md border border-input bg-background px-2 text-sm"/>
    </label>
    <label className="flex flex-col gap-1 text-xs">{t('dateTo')}
      <input type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} aria-label={t('dateToLabel', {name})} className="min-h-9 rounded-md border border-input bg-background px-2 text-sm"/>
    </label>
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" className="min-h-9 rounded-md border border-border px-3" onClick={() => finish({from: '', to: ''})}>{t('clearChoice')}</button>
      <button type="button" disabled={!valid(from) || !valid(to) || !ordered} className="min-h-9 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50" onClick={() => finish({from, to})}>{t('applyChoice')}</button>
    </div>
  </HeaderPanel>;
}
