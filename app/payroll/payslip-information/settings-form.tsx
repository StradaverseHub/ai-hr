'use client';
/**
 * Payslip Information Setup — which Employment Info fields a company's payslips show, and in what ORDER
 * (r389, 23bd49d9).
 *
 * The saved `fields` list is the reading order on every payslip output (core/payslip-information.ts keeps
 * it as stored). The screen is a DRAFT until Save: switching, dragging and the Move buttons change local
 * state only, and Save posts the shown keys in order as repeated `fields` inputs.
 *
 * Reordering follows app/admin/personnel/column-picker.tsx: native HTML5 drag on the row, and Move up /
 * Move down buttons beside it that are the accessible path, not a fallback (keyboard, screen reader, a
 * tablet where dragging is awkward). Switching a field on APPENDS it to the shown list; switching it off
 * drops it to "Not shown", which is listed in the catalogue order and unnumbered.
 *
 * Copy to Companies is its own form (forms cannot nest), so the Save button reaches the save form through
 * the `form` attribute. Copy always copies the SAVED setting, so an unsaved draft is called out in its dialog.
 */
import { useActionState, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { PAYSLIP_INFORMATION_FIELDS } from '@/core/payslip-information';
import { savePayslipInformation, copyPayslipInformation } from './actions';
import { Button, Card, ErrorBanner } from '@/components/ui';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { cn } from '@/lib/utils';

type Company = {id: string; name: string};

function ShownSwitch({on, label, onToggle, disabled}: {on: boolean; label: string; onToggle: () => void; disabled?: boolean}) {
  const t = useTranslations('payroll.payslipInformation');
  return <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
    <span aria-hidden="true">{t('shownToggle')}</span>
    <button type="button" role="switch" aria-checked={on} aria-label={`${t('shownToggle')}: ${label}`}
      disabled={disabled} onClick={onToggle}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        on ? 'bg-primary' : 'bg-muted-foreground/30')}>
      <span aria-hidden="true" className={cn('inline-block size-4 rounded-full bg-background shadow transition-transform', on ? 'translate-x-4' : 'translate-x-0.5')}/>
    </button>
  </span>;
}

export function SettingsForm({companyId, companyName, fields, otherCompanies}: {
  companyId: string;
  companyName: string;
  /** The SAVED shown fields, in their saved order. */
  fields: readonly string[];
  /** Companies the caller may manage, other than this one. Empty ⇒ no Copy to Companies. */
  otherCompanies: Company[];
}) {
  const t = useTranslations('payroll.payslipInformation');
  const saveFormId = useId();
  const [state, action, pending] = useActionState(savePayslipInformation, {error: '', saved: false});
  const [shown, setShown] = useState<string[]>([...fields]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const hidden = PAYSLIP_INFORMATION_FIELDS.filter(k => !shown.includes(k));
  const dirty = shown.join(',') !== fields.join(',');
  const label = (k: string) => t(k as (typeof PAYSLIP_INFORMATION_FIELDS)[number]);

  const moveTo = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= shown.length || to >= shown.length) return;
    const next = [...shown];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setShown(next);
  };
  const hide = (k: string) => setShown(cur => cur.filter(x => x !== k));
  const show = (k: string) => setShown(cur => (cur.includes(k) ? cur : [...cur, k]));

  const moveCls = 'inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40';

  return <Card className="p-6">
    <h2 className="mb-5 font-semibold">{t('heading')}</h2>
    {state.error && <p role="alert" className="mb-4 text-destructive">{state.error}</p>}
    {state.saved && <p role="status" className="mb-4 text-emerald-700 dark:text-emerald-400">{t('saved')}</p>}
    <form id={saveFormId} action={action}>
      <input type="hidden" name="companyId" value={companyId}/>
      {shown.map(k => <input key={k} type="hidden" name="fields" value={k}/>)}
    </form>

    <section aria-labelledby={`${saveFormId}-shown`}>
      <h3 id={`${saveFormId}-shown`} className="mb-2 text-sm font-semibold">{t('shownHeading')}</h3>
      {shown.length === 0
        ? <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">{t('noneShown')}</p>
        : <ol className="space-y-2">{shown.map((k, i) => <li key={k} draggable={!pending} data-field={k}
            onDragStart={() => setDragIndex(i)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); if (dragIndex !== null) moveTo(dragIndex, i); setDragIndex(null); }}
            onDragEnd={() => setDragIndex(null)}
            className={cn('flex min-h-12 flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2', dragIndex === i && 'opacity-50')}>
            <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/70 active:cursor-grabbing" aria-hidden/>
            <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
            <span className="min-w-0 flex-1 font-medium">{label(k)}</span>
            <span className="flex shrink-0 items-center gap-2">
              <button type="button" className={moveCls} aria-label={`${t('moveUp')}: ${label(k)}`} disabled={pending || i === 0} onClick={() => moveTo(i, i - 1)}>
                <ArrowUp className="size-3.5" aria-hidden/>{t('moveUp')}
              </button>
              <button type="button" className={moveCls} aria-label={`${t('moveDown')}: ${label(k)}`} disabled={pending || i === shown.length - 1} onClick={() => moveTo(i, i + 1)}>
                <ArrowDown className="size-3.5" aria-hidden/>{t('moveDown')}
              </button>
            </span>
            <ShownSwitch on label={label(k)} disabled={pending} onToggle={() => hide(k)}/>
          </li>)}</ol>}
    </section>

    <section aria-labelledby={`${saveFormId}-hidden`} className="mt-6">
      <h3 id={`${saveFormId}-hidden`} className="mb-2 text-sm font-semibold">{t('hiddenHeading')}</h3>
      {hidden.length === 0
        ? <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">{t('noneHidden')}</p>
        : <ul className="space-y-2">{hidden.map(k => <li key={k} data-field={k}
            className="flex min-h-12 items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
            <span className="min-w-0 flex-1 pl-[3.25rem] text-muted-foreground">{label(k)}</span>
            <ShownSwitch on={false} label={label(k)} disabled={pending} onToggle={() => show(k)}/>
          </li>)}</ul>}
    </section>

    <p className="mt-4 text-xs text-muted-foreground">{t('orderNote')}</p>

    <div className="mt-6 flex flex-wrap items-end justify-between gap-4 border-t border-border pt-4">
      {otherCompanies.length > 0
        ? <CopyToCompanies companyId={companyId} companyName={companyName} companies={otherCompanies} dirty={dirty}/>
        : <span/>}
      <div className="ml-auto flex gap-3">
        <Button asChild variant="outline"><a href="/payroll/setup">{t('cancel')}</a></Button>
        <Button type="submit" form={saveFormId} disabled={pending}>{pending ? t('saving') : t('save')}</Button>
      </div>
    </div>
  </Card>;
}

/**
 * Copy to Companies, as the approved sketch draws it: ONE dialog holding the company checklist (Select All
 * Companies first), the replace / independent-afterwards / issued-payslips warning, and Copy Settings.
 *
 * Why not MultiSelectPopover + ConfirmSubmit (the build notes' first idea): measured in the r389 render check,
 * the picker sits at the bottom of a long page and its open panel extends the scroll area; the mousedown on
 * the Copy button closes it, the page shortens, and the button moves out from under the pointer, so the first
 * click is lost. A checklist inside the dialog has nothing to collapse, and it is one click fewer.
 *
 * Built on the same Radix AlertDialog, overlay and panel styling as components/ui/confirm-submit.tsx. The
 * form lives INSIDE the portalled content, so the ticked ids post from where they are chosen.
 */
function CopyToCompanies({companyId, companyName, companies, dirty}: {companyId: string; companyName: string; companies: Company[]; dirty: boolean}) {
  const t = useTranslations('payroll.payslipInformation');
  const [state, action, pending] = useActionState(copyPayslipInformation, {error: '', copiedTo: [] as string[]});
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const nameOf = useMemo(() => new Map(companies.map(c => [c.id, c.name])), [companies]);
  const all = selected.size === companies.length;
  const toggle = (id: string) => setSelected(cur => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const rowCls = 'flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm';
  const boxCls = 'size-4 shrink-0 accent-[var(--color-primary)]';
  return <div className="flex max-w-xl flex-col gap-2">
    <AlertDialog.Root open={open} onOpenChange={o => { if (o) setSelected(new Set()); setOpen(o); }}>
      <AlertDialog.Trigger asChild>
        <Button type="button" variant="outline" disabled={pending}>{t('copyButton')}</Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <form action={action} onSubmit={() => setOpen(false)}>
            <input type="hidden" name="companyId" value={companyId}/>
            {companies.filter(c => selected.has(c.id)).map(c => <input key={c.id} type="hidden" name="targetCompanyIds" value={c.id}/>)}
            <AlertDialog.Title className="text-base font-semibold">{t('copyTitle')}</AlertDialog.Title>
            <AlertDialog.Description className="mt-1.5 text-sm text-foreground">{t('copyIntro', {source: companyName})}</AlertDialog.Description>
            <div role="group" aria-label={t('copyButton')} className="mt-3 max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
              <label className={cn(rowCls, 'bg-muted/40 font-medium')}>
                <input type="checkbox" className={boxCls} checked={all} onChange={() => setSelected(all ? new Set() : new Set(companies.map(c => c.id)))}/>
                {t('copySelectAll')}
              </label>
              {companies.map(c => <label key={c.id} className={cn(rowCls, 'hover:bg-muted')}>
                <input type="checkbox" className={boxCls} checked={selected.has(c.id)} onChange={() => toggle(c.id)}/>
                <span className="min-w-0 truncate">{c.name}</span>
              </label>)}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{t('copyWarning')}</p>
            {dirty && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('copyUnsaved')}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild><Button type="button" variant="outline" size="sm">{t('cancel')}</Button></AlertDialog.Cancel>
              <Button type="submit" size="sm" disabled={selected.size === 0 || pending}>{t('copyConfirm')}</Button>
            </div>
          </form>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
    {state.error && <ErrorBanner message={state.error}/>}
    {state.copiedTo.length > 0 && !state.error && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
      {t('copied', {companies: state.copiedTo.map(id => nameOf.get(id) ?? id).join(', ')})}</p>}
  </div>;
}
