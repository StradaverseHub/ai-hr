'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { LifecycleV9WorkflowRemovalPreview as Preview, LifecycleV9WorkflowRemovalResult as Result } from '@/packs/lifecycle/service';
import type { Workflow } from '@/lib/lifecycle-v9-model';

type Outcome<T> = { ok: true; result: T } | { ok: false; error: string };
/** Server actions supplied by the workspace. The service re-checks permission, usage and the configuration revision. */
export type WorkflowRemovalActions = {
  /** Local settings edits must be saved first so the action and the autosave never race on the configuration revision. */
  saved: boolean;
  preview: (workflowId: string) => Promise<{ ok: true; preview: Preview } | { ok: false; error: string }>;
  remove: (input: { revision: number; workflowId: string; expected: { mode: Preview['mode']; cases: number; automatic: boolean } }) => Promise<Outcome<Result>>;
  restore: (input: { revision: number; workflowId: string; name?: string }) => Promise<Outcome<{ revision: number }>>;
  changed: (message: string) => void;
};

function Confirm({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), t = useTranslations('lifecycle.workflowRemoval');
  useEffect(() => { const element = ref.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={ref} className="v9-dialog v9-confirm" aria-label={title} onCancel={close}><header><h2>{title}</h2><button type="button" className="v9-button" aria-label={t('close')} onClick={close}><X size={18}/></button></header><div className="v9-stack">{children}</div></dialog>;
}

export function RemoveWorkflowDialog({ workflow, actions, close }: { workflow: Workflow; actions: WorkflowRemovalActions; close: () => void }) {
  const t = useTranslations('lifecycle.workflowRemoval');
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [changed, setChanged] = useState(false), [busy, setBusy] = useState(false);
  const check = actions.preview, failed = t('checkFailed');
  useEffect(() => {
    let live = true;
    check(workflow.id).then(result => { if (!live) return; if (result.ok) setPreview(result.preview); else setError(result.error); }).catch(() => { if (live) setError(failed); });
    return () => { live = false; };
  }, [workflow.id, check, failed]);
  async function confirm() {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const result = await actions.remove({ revision: preview.revision, workflowId: preview.workflowId, expected: { mode: preview.mode, cases: preview.cases, automatic: preview.automatic } });
      if (!result.ok) setError(result.error);
      else if (!result.result.done) { setPreview(result.result.preview); setChanged(true); }
      else { actions.changed(result.result.mode === 'delete' ? t('deleted', { name: preview.name }) : t('retired', { name: preview.name })); close(); }
    } catch { setError(t('failed')); } finally { setBusy(false); }
  }
  const name = preview?.name ?? workflow.name, retire = preview?.mode === 'retire';
  return <Confirm title={!preview ? t('checkingTitle', { name }) : retire ? t('retireTitle', { name }) : t('deleteTitle', { name })} close={close}>
    {!preview && !error && <p className="v9-muted" role="status">{t('checking')}</p>}
    {changed && <p className="v9-notice v9-warning" role="status">{t('changed')}</p>}
    {preview && (retire ? <><p>{t('retireBody', { cases: preview.cases })}</p><p className="v9-muted">{t('retireEffect')}</p></> : <p>{t('deleteBody')}</p>)}
    {preview?.automatic && <p className="v9-notice v9-warning">{t('automaticWarning', { when: preview.when.toLocaleLowerCase() })}</p>}
    {!actions.saved && <p className="v9-muted">{t('saveFirst')}</p>}
    {error && <p className="v9-notice v9-error" role="alert">{error}</p>}
    <div className="v9-actions v9-confirm-actions"><button type="button" className="v9-button" onClick={close}>{t('cancel')}</button>{preview && <button type="button" aria-busy={busy} className={'v9-button ' + (retire ? 'v9-button-primary' : 'v9-button-destructive')} disabled={busy || !actions.saved} onClick={() => void confirm()}>{retire ? t('confirmRetire') : t('confirmDelete')}</button>}</div>
  </Confirm>;
}

export function RestoreWorkflowDialog({ workflow, workflows, revision, actions, close }: { workflow: Workflow; workflows: Workflow[]; revision: number; actions: WorkflowRemovalActions; close: () => void }) {
  const t = useTranslations('lifecycle.workflowRemoval');
  const [name, setName] = useState(workflow.name), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const key = (value: string) => value.trim().toLocaleLowerCase();
  const clash = (value: string) => workflows.find(candidate => candidate.id !== workflow.id && candidate.module === workflow.module && candidate.status !== 'retired' && key(candidate.name) === key(value));
  const original = clash(workflow.name), current = clash(name), valid = !!name.trim() && !current;
  async function confirm() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      const result = await actions.restore({ revision, workflowId: workflow.id, ...(name.trim() !== workflow.name ? { name: name.trim() } : {}) });
      if (!result.ok) setError(result.error);
      else { actions.changed(t('restored', { name: name.trim() })); close(); }
    } catch { setError(t('failed')); } finally { setBusy(false); }
  }
  return <Confirm title={t('restoreTitle', { name: workflow.name })} close={close}>
    <p>{t('restoreBody')}</p>
    <p className="v9-notice v9-warning">{workflow.retired?.automatic ? t('restoreWasAutomatic') : t('restoreNotLive')}</p>
    {original && <><p className="v9-notice v9-warning" role="status">{t('duplicateName', { name: original.name })}</p><label className="v9-field"><span>{t('newName')}</span><input className="v9-input" value={name} maxLength={200} onChange={event => setName(event.target.value)}/></label>{current && <p className="v9-muted">{t('stillDuplicate')}</p>}</>}
    {!actions.saved && <p className="v9-muted">{t('saveFirst')}</p>}
    {error && <p className="v9-notice v9-error" role="alert">{error}</p>}
    <div className="v9-actions v9-confirm-actions"><button type="button" className="v9-button" onClick={close}>{t('cancel')}</button><button type="button" aria-busy={busy} className="v9-button v9-button-primary" disabled={busy || !valid || !actions.saved} onClick={() => void confirm()}>{t('confirmRestore')}</button></div>
  </Confirm>;
}
