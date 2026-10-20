'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { ChevronDown, X } from 'lucide-react';
import { inputCls } from './ui';

export type RosterLegendEntry = { value: string | null; code: string; name: string; hint: string; className: string; style?: CSSProperties };
/** A searchable, portaled dropdown. Choosing a brush changes no roster until a cell is explicitly assigned. */
export function RosterLegend({ entries, active, onChoose }: { entries: RosterLegendEntry[]; active: string; onChoose?: (value: string) => void }) {
  const t = useTranslations('roster');
  const searchId = useId();
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const selected = entries.find(entry => entry.value === active);
  function locate() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(384, window.innerWidth - 32), below = window.innerHeight - rect.bottom - 22, above = rect.top - 22;
    const placeBelow = below >= Math.min(320, above);
    const cramped = Math.max(above, below) < 180;
    setPosition({ width, left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
      ...(cramped ? { top: 16 } : placeBelow ? { top: Math.max(16, rect.bottom + 6) } : { bottom: Math.max(16, window.innerHeight - rect.top + 6) }),
      maxHeight: Math.max(0, Math.min(384, window.innerHeight - 32, cramped ? window.innerHeight - 32 : placeBelow ? below : above)) });
  }
  useEffect(() => {
    if (!open) return;
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) locate(); };
    window.addEventListener('resize', locate); window.addEventListener('scroll', scroll, { capture: true, passive: true });
    return () => { window.removeEventListener('resize', locate); window.removeEventListener('scroll', scroll, true); };
  }, [open]);
  const visible = entries.filter(entry => `${entry.code} ${entry.name} ${entry.hint}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Dialog.Root modal={false} open={open} onOpenChange={next => { if (next) { locate(); setQuery(''); } setOpen(next); }}>
    <Dialog.Trigger asChild><button ref={trigger} type="button" className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm">
      <span className="shrink-0 font-medium">{t(onChoose ? 'brush' : 'legend')}</span>
      {selected && onChoose && <span style={selected.style} className={`min-w-0 truncate rounded border px-2 py-0.5 text-xs ${selected.className}`}>{selected.code}</span>}
      <ChevronDown className="size-4 shrink-0" aria-hidden />
    </button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Content ref={panel} style={position} aria-describedby={undefined} onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }} className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl">
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 pt-2"><Dialog.Title className="text-sm font-semibold">{t('legend')}</Dialog.Title><Dialog.Close asChild><button type="button" aria-label={t('legendClose')} className="grid size-11 place-items-center rounded hover:bg-muted"><X className="size-4" aria-hidden /></button></Dialog.Close></div>
      <div className="shrink-0 px-3 pb-2"><label className="sr-only" htmlFor={searchId}>{t('legendSearch')}</label><input id={searchId} ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('legendSearch')} className={inputCls} /></div>
      <div className="min-h-0 overflow-y-auto p-2">
        {!visible.length && <p role="status" className="p-3 text-sm text-muted-foreground">{t('legendEmpty')}</p>}
        {visible.map(entry => {
          const content = <><span style={entry.style} className={`shrink-0 rounded border px-2 py-1 text-xs font-medium ${entry.className}`}>{entry.code}</span><span className="min-w-0 text-left text-sm"><span className="block break-words">{entry.name}</span><span className="block text-xs text-muted-foreground">{entry.hint}</span></span></>;
          return entry.value != null && onChoose ? <button key={entry.value} type="button" aria-pressed={entry.value === active} className="flex min-h-11 w-full items-center gap-3 rounded p-2 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { onChoose(entry.value!); setOpen(false); }}>{content}</button> : <div key={entry.value ?? 'off'} className="flex min-h-11 items-center gap-3 p-2">{content}</div>;
        })}
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
