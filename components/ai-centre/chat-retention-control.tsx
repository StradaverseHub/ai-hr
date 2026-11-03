'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setChatRetentionAction } from '@/app/assistant/chat-actions';
import { ConfirmDialog } from '@/components/ui/confirm-submit';
import { btnPrimary } from '@/components/ui';

/** The owner's list (core/teras-chats.ts CHAT_KEEP_DAYS). Repeated here because that module reaches the database
 * client; test/ai-centre-ask-everywhere.dom.test.tsx pins the two lists equal. */
export const KEEP_CHAT_OPTIONS = [1, 7, 30, 90, 180, 365] as const;

/** AI v2 Phase 1, W4 — "Keep chats for", under AI Centre › Administration › Setup › Assistant.
 *
 * A group administrator chooses 1, 7, 30, 90, 180 or 365 days and confirms; the confirmation says that a shorter
 * value deletes older chats soon (the owner brings every chat's expiry forward at once) and that a longer one
 * applies from each chat's next message. Saving goes through setChatRetentionAction, whose owner re-proves the
 * group administrator in the database and audits the change; this component only decides what to show. Everyone
 * else sees the current value, read-only. */
export function ChatRetentionControl({ keepDays, mayChange }: { keepDays: number | null; mayChange: boolean }) {
  const t = useTranslations('aiAsk.retention');
  const router = useRouter();
  const [saved, setSaved] = useState(keepDays);
  const [choice, setChoice] = useState<number | null>(keepDays);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);

  if (!mayChange || saved === null) {
    return <p data-chat-retention="read-only" className="text-sm">
      {saved === null ? t('unavailable') : t('readOnly', { days: saved })}
    </p>;
  }

  const shorter = choice !== null && choice < saved;
  async function save() {
    setConfirming(false);
    if (choice === null) return;
    setPending(true); setStatus(null);
    try {
      const result = await setChatRetentionAction({ keepDays: choice });
      if (result.ok) {
        setSaved(result.keepDays); setChoice(result.keepDays);
        setStatus({ kind: 'status', text: t('saved', { days: result.keepDays }) });
        router.refresh();
      } else setStatus({ kind: 'alert', text: result.code === 'not_administrator' ? t('notAdministrator') : t('failed') });
    } catch { setStatus({ kind: 'alert', text: t('failed') }); }
    finally { setPending(false); }
  }

  return <form data-chat-retention="editable" onSubmit={event => { event.preventDefault(); if (choice !== null && choice !== saved) setConfirming(true); }} className="space-y-3">
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('legend')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">{KEEP_CHAT_OPTIONS.map(days => <label key={days} className="flex min-h-11 items-center gap-2 text-sm">
        <input type="radio" name="keepDays" value={days} checked={choice === days} onChange={() => { setChoice(days); setStatus(null); }} className="size-4"/>
        {t('option', { days })}
      </label>)}</div>
    </fieldset>
    <button type="submit" disabled={pending || choice === null || choice === saved} className={btnPrimary + ' min-h-11'}>{t('save')}</button>
    {status && <p role={status.kind} className="text-sm">{status.text}</p>}
    {confirming && choice !== null && <ConfirmDialog
      title={t('confirmTitle')}
      description={shorter ? t('confirmShorter', { days: choice }) : t('confirmLonger', { days: choice })}
      confirmLabel={t('confirm')}
      variant={shorter ? 'destructive' : 'default'}
      onConfirm={() => void save()}
      onCancel={() => setConfirming(false)}/>}
  </form>;
}
