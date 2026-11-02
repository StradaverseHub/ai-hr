'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PayFormulaDraft } from '@/lib/pay-formula-ai';
import { draftFormulaAction } from './actions';
import { formulaButton, formulaInput, formulaPrimary } from './ui-types';

export function FormulaGenerator({ source, disabled, apply }: {
  source: string; disabled: boolean; apply: (source: string) => void;
}) {
  const t = useTranslations('payFormula.generator');
  const [requirement, setRequirement] = useState(''), [accepted, setAccepted] = useState(false);
  const [result, setResult] = useState<PayFormulaDraft | null>(null), [error, setError] = useState('');
  const [pending, setPending] = useState(false), [replace, setReplace] = useState(false);
  const generation = useRef(0), busy = useRef(false);
  async function generate() {
    if (busy.current || disabled || !accepted || !requirement.trim()) return;
    const token = ++generation.current;
    busy.current = true; setPending(true); setError(''); setResult(null); setReplace(false);
    try {
      const reply = await draftFormulaAction({ requirement, disclosureAccepted: accepted });
      if (token !== generation.current) return;
      if (reply.ok) setResult(reply.value); else setError(reply.error);
    } catch { if (token === generation.current) setError(t('failed')); }
    finally { if (token === generation.current) { busy.current = false; setPending(false); } }
  }
  function clear() {
    generation.current++; busy.current = false; setPending(false); setRequirement('');
    setResult(null); setError(''); setReplace(false); setAccepted(false);
  }
  function insert() {
    if (disabled || !result?.valid || !result.source) return;
    apply(result.source); setReplace(false);
  }
  return <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-5" aria-labelledby="formula-generator-title">
    <h2 id="formula-generator-title" className="font-semibold">{t('title')}</h2>
    <label className="block space-y-2 text-sm">{t('requirement')}
      <textarea className={formulaInput + ' min-h-40 resize-y'} maxLength={4000} value={requirement} disabled={disabled}
        onChange={event => { generation.current++; busy.current=false; setPending(false); setRequirement(event.target.value); setResult(null); setReplace(false); }}/>
    </label>
    <p className="text-sm text-muted-foreground">{t('disclosure')}</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} disabled={disabled}
      onChange={event => { setAccepted(event.target.checked); if(!event.target.checked){generation.current++;busy.current=false;setPending(false);setResult(null);} }}/>{t('consent')}</label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={formulaPrimary} disabled={disabled || pending || !accepted || !requirement.trim()} onClick={generate}>{t(pending ? 'working' : result ? 'regenerate' : 'generate')}</button>
      <button type="button" className={formulaButton} onClick={clear}>{t('clear')}</button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <div className="space-y-3" role="status">
      <p className="text-sm">{result.explanation}</p>
      {result.questions.map((question,index)=><p key={'q'+index} className="text-sm">{question}</p>)}
      {result.unsupported.map((issue,index)=><p key={'u'+index} className="text-sm text-destructive">{issue}</p>)}
      {result.source && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-xs">{result.source}</pre>}
      {result.variables.length>0 && <p className="text-sm text-muted-foreground">{t('variables')}: {result.variables.join(', ')}</p>}
      <p className="text-sm">{t(result.valid ? 'valid' : 'needsClarification')}</p>
      {replace ? <div role="alertdialog" aria-label={t('replaceTitle')} className="space-y-3 rounded-lg border border-border p-3">
        <p className="text-sm">{t('replaceHelp')}</p><div className="flex flex-wrap gap-2"><button className={formulaPrimary} type="button" disabled={disabled} onClick={insert}>{t('replace')}</button><button className={formulaButton} type="button" onClick={()=>setReplace(false)}>{t('cancel')}</button></div>
      </div> : <button type="button" className={formulaButton} disabled={disabled || !result.valid} onClick={()=>source.trim()?setReplace(true):insert()}>{t('apply')}</button>}
    </div>}
    <p className="text-xs text-muted-foreground">{t('draftOnly')}</p>
  </section>;
}
