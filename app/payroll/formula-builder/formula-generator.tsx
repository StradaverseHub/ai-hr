'use client';
import { ActionButton } from '@/components/ui/action-button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PayFormulaDraft } from '@/lib/pay-formula-ai';
import type { PayFormulaDraftJobReason, PayFormulaDraftJobView } from '@/lib/pay-formula-draft-job';
import { discardFormulaDraftAction, readFormulaDraftAction, startFormulaDraftAction } from './actions';
import { formulaButton, formulaInput, formulaPrimary } from './ui-types';

/** Polling of the background generation: one primary-key read per poll, stopped at the server's deadline
 *  (budget plus grace, after which the server reports the run as interrupted) or after a bounded count. */
const POLL_MS = 2000, GRACE_SECONDS = 90;
const REASON_KEYS: Partial<Record<PayFormulaDraftJobReason, 'reviewRequired' | 'unavailable' | 'failed'>> = { review_required: 'reviewRequired', unavailable: 'unavailable', failed: 'failed' };

export function FormulaGenerator({ source, disabled, apply, pollMs = POLL_MS }: {
  source: string; disabled: boolean; apply: (source: string) => void; pollMs?: number;
}) {
  const t = useTranslations('payFormula.generator');
  const [requirement, setRequirement] = useState(''), [accepted, setAccepted] = useState(false);
  const [result, setResult] = useState<PayFormulaDraft | null>(null), [error, setError] = useState('');
  const [pending, setPending] = useState(false), [replace, setReplace] = useState(false);
  const generation = useRef(0), busy = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reasonText = useCallback((reason: PayFormulaDraftJobReason | null, seconds: number) => {
    const key = reason ? REASON_KEYS[reason] : 'failed';
    return key ? t(key) : t(`reasons.${reason}`, { seconds });
  }, [t]);
  const stop = useCallback(() => { generation.current++; busy.current = false; clearTimeout(timer.current); setPending(false); }, []);
  /** Shows one generation and keeps polling it while it runs; a newer local generation stops this one. */
  const follow = useCallback((job: PayFormulaDraftJobView, token: number, polls = 0) => {
    if (token !== generation.current) return;
    if (job.state === 'running') {
      busy.current = true; setPending(true);
      if (polls > Math.ceil((job.timeoutSeconds + GRACE_SECONDS) * 1000 / pollMs)) { busy.current = false; setPending(false); setError(t('failed')); return; }
      timer.current = setTimeout(async () => {
        if (token !== generation.current) return;
        try {
          const reply = await readFormulaDraftAction();
          if (token !== generation.current) return;
          if (!reply.ok) { busy.current = false; setPending(false); setError(reply.error); return; }
          if (!reply.value || reply.value.id !== job.id) { busy.current = false; setPending(false); setError(t('failed')); return; }
          follow(reply.value, token, polls + 1);
        } catch { if (token === generation.current) { busy.current = false; setPending(false); setError(t('failed')); } }
      }, pollMs);
      return;
    }
    busy.current = false; setPending(false);
    if (job.state === 'succeeded' && job.result) setResult(job.result); else setError(reasonText(job.reason, job.timeoutSeconds));
  }, [pollMs, reasonText, t]);
  const followRef = useRef(follow);
  useEffect(() => { followRef.current = follow; }, [follow]);
  // A reload resumes the author's pending or finished draft: one read when the generator becomes usable.
  useEffect(() => {
    if (disabled) return;
    const token = ++generation.current;
    (async () => {
      try {
        const reply = await readFormulaDraftAction();
        if (token === generation.current && reply.ok && reply.value) followRef.current(reply.value, token);
      } catch { /* the generator stays usable; a later Generate reports its own outcome */ }
    })();
    return () => { generation.current++; busy.current = false; clearTimeout(timer.current); };
  }, [disabled]);
  async function generate() {
    if (busy.current || disabled || !accepted || !requirement.trim()) return;
    const token = ++generation.current;
    busy.current = true; setPending(true); setError(''); setResult(null); setReplace(false);
    try {
      const reply = await startFormulaDraftAction({ requirement, disclosureAccepted: accepted });
      if (token !== generation.current) return;
      if (!reply.ok) { busy.current = false; setPending(false); setError(reply.error); return; }
      if (reply.value.outcome === 'busy') { busy.current = false; setPending(false); setError(t('busy', { seconds: reply.value.job.timeoutSeconds })); return; }
      follow(reply.value.job, token);
    } catch { if (token === generation.current) { busy.current = false; setPending(false); setError(t('failed')); } }
  }
  function clear() {
    stop(); setRequirement('');
    setResult(null); setError(''); setReplace(false); setAccepted(false);
    void Promise.resolve().then(() => discardFormulaDraftAction()).catch(() => undefined);
  }
  function insert() {
    if (disabled || !(result?.valid || result?.unresolved) || !result.source) return;
    apply(result.source); setReplace(false);
  }
  return <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-5" aria-labelledby="formula-generator-title">
    <h2 id="formula-generator-title" className="font-semibold">{t('title')}</h2>
    <label className="block space-y-2 text-sm">{t('requirement')}
      <textarea className={formulaInput + ' min-h-40 resize-y'} maxLength={4000} value={requirement} disabled={disabled}
        onChange={event => { stop(); setRequirement(event.target.value); setResult(null); setReplace(false); }}/>
    </label>
    <p className="text-sm text-muted-foreground">{t('disclosure')}</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} disabled={disabled}
      onChange={event => { setAccepted(event.target.checked); if(!event.target.checked){stop();setResult(null);} }}/>{t('consent')}</label>
    <div className="flex flex-wrap gap-2">
      <ActionButton type="button" className={formulaPrimary} disabled={disabled || pending || !accepted || !requirement.trim()} onClick={generate}>{t(pending ? 'working' : result ? 'regenerate' : 'generate')}</ActionButton>
      <button type="button" className={formulaButton} onClick={clear}>{t('clear')}</button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <div className="space-y-3" role="status">
      <div><h3 className="text-sm font-medium">{t('issue')}</h3><p className="text-sm">{result.explanation}</p></div>
      <h3 className="text-sm font-medium">{t('suggestedFormula')}</h3>
      {result.source && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-xs">{result.source}</pre>}
      <div><h3 className="text-sm font-medium">{t('assumptions')}</h3>{result.assumptions?.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{result.assumptions.map((value,index)=><li key={index}>{value}</li>)}</ul> : <p className="text-sm text-muted-foreground">{t('noAssumptions')}</p>}</div>
      <h3 className="text-sm font-medium">{t('nextStep')}</h3>
      {result.questions.map((question,index)=><p key={'q'+index} className="text-sm">{question}</p>)}
      {result.unsupported.map((issue,index)=><p key={'u'+index} className="text-sm text-destructive">{issue}</p>)}
      {result.conditions.length>0 && <div className="space-y-1 text-sm"><p className="font-medium">{t('conditions')}</p>{result.conditions.map((condition,index)=><p className="break-words font-mono text-xs" key={index}>{condition}</p>)}</div>}
      {result.variables.length>0 && <p className="text-sm text-muted-foreground">{t('variables')}: {result.variables.join(', ')}</p>}
      <p className="text-sm">{t(result.valid ? 'valid' : 'needsClarification')}</p>
      {replace ? <div role="alertdialog" aria-label={t('replaceTitle')} className="space-y-3 rounded-lg border border-border p-3">
        <p className="text-sm">{t('replaceHelp')}</p><div className="flex flex-wrap gap-2"><button className={formulaPrimary} type="button" disabled={disabled} onClick={insert}>{t('replace')}</button><button className={formulaButton} type="button" onClick={()=>setReplace(false)}>{t('cancel')}</button></div>
      </div> : <button type="button" className={formulaButton} disabled={disabled || !(result.valid || result.unresolved)} onClick={()=>source.trim()?setReplace(true):insert()}>{t('apply')}</button>}
    </div>}
    <p className="text-xs text-muted-foreground">{t('draftOnly')}</p>
  </section>;
}
