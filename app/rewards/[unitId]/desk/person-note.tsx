'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { useReviewDesk } from './review-desk';

/** 37f82412 — the short Notes field in the person panel. It saves through the same review owner as the cells. */
export function PersonNote({ entryId, note, editable, max }: { entryId: string; note: string; editable: boolean; max: number }) {
  const { save } = useReviewDesk();
  const t = useTranslations('rewards.desk.person');
  const [saved, setSaved] = useState(note);
  const [draft, setDraft] = useState(note);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [error, setError] = useState('');
  useEffect(() => { setSaved(note); setDraft(note); }, [note]);
  if (!editable) return note ? <p className="whitespace-pre-wrap text-sm">{note}</p> : <p className="text-sm text-muted-foreground">{t('noNote')}</p>;
  return <div className="space-y-2">
    <label className="block text-sm"><span className="sr-only">{t('notes')}</span>
      <textarea rows={3} maxLength={max} value={draft} onChange={event => { setDraft(event.target.value); setState('idle'); }} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
    <div className="flex items-center gap-3">
      <Button type="button" size="sm" variant="outline" disabled={state === 'saving' || draft.trim() === saved.trim()} onClick={async () => {
        setState('saving'); setError('');
        const result = await save(entryId, 'note', draft);
        if (result.ok) { setSaved(draft.trim()); setState('saved'); } else { setError(result.error); setState('failed'); }
      }}>{t('saveNote')}</Button>
      {state === 'saved' && <span role="status" className="text-xs text-muted-foreground">{t('noteSaved')}</span>}
      {state === 'failed' && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>
  </div>;
}

/** Opens a collapsed section when a link targets it (Go to section from Flags), keeping anchors working. */
export function OpenDetailsOnHash() {
  useEffect(() => {
    const open = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      const details = target instanceof HTMLDetailsElement ? target : target?.closest('details');
      if (details) { details.open = true; target?.scrollIntoView({ block: 'start' }); }
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);
  return null;
}
