'use client';

/**
 * AI provider configuration (ADR-0023) — admin Settings client island. One card per provider: pick a
 * model, paste an API key (write-only — shown as ••••last4 once stored), test the connection, save,
 * and choose which provider is active. The key field is `type=password` + `autoComplete=off`; the
 * plaintext key is sent to a server action that encrypts it before it touches the DB and is never
 * echoed back. "Test" returns only ok/generic-reason.
 */
import { useState, useTransition, useId, useRef, useEffect } from 'react';
import { readOpenRouterOptions, type OpenRouterOptions } from '@/lib/ai/providers/openrouter-configuration';
import { useFormatter,useTranslations } from 'next-intl';
import type {ProviderProtocolSummary} from '@/lib/ai/provider-protocol';
import { toast } from 'sonner';
import { Loader2, PlugZap, Trash2 } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import type { AiConfigView, AiProviderView } from '@/core/ai-config';
import {
  evaluateProviderCandidateAction,
  disableAiAction,
  discardPendingProviderChangeAction,
  removeAiProviderConfigAction,
  saveAiProviderConfigAction,
  setActiveProviderAction,
  testConnectionAction,
} from '@/app/admin/ai/actions';
// WP14: a direct provider's save is stored as a pending change; it is activated from the baseline checks section.

export function AiConfigForm({ config }: { config: AiConfigView }) {
  const t = useTranslations('admin.ai');
  const anyActive = config.providers.some((p) => p.isActive);
  return (
    <div className="space-y-4">
      {anyActive && (
        <form action={disableAiAction} className="flex justify-end">
          <Button type="submit" variant="ghost" size="sm">
            {t('deactivateTenantConfig')}
          </Button>
        </form>
      )}
      {config.providers.map((p) => (
        <ProviderCard key={p.provider+':'+(p.candidateVersion??'live')} p={p} storable={config.storable} />
      ))}
    </div>
  );
}

function ProviderCard({ p, storable }: { p: AiProviderView; storable: boolean }) {
  const t = useTranslations('admin.ai'),f=useFormatter();
  const [model, setModel] = useState(p.model);
  const [key, setKey] = useState('');
  const [testing, startTest] = useTransition();
  const [evaluating, startEvaluation] = useTransition();
  const [accountReview, setAccountReview] = useState(false);
  const [consent, setConsent] = useState(false);
  const [evaluation, setEvaluation] = useState<{ receipt: string; expiresAt: string; candidateId: string; candidateVersion: string; summary:ProviderProtocolSummary } | null>(null);
  const [evaluationFailed, setEvaluationFailed] = useState(false);
  const [receiptClock,setReceiptClock]=useState(()=>Date.now());
  useEffect(()=>{setReceiptClock(Date.now());if(!evaluation)return;const expiry=Date.parse(evaluation.expiresAt);if(!Number.isFinite(expiry))return;const timer=setTimeout(()=>setReceiptClock(Date.now()),Math.min(2147483647,Math.max(0,expiry-Date.now()+1)));return()=>clearTimeout(timer);},[evaluation?.receipt,evaluation?.expiresAt]);
  const evaluationSequence=useRef(0),metadataSequence=useRef(0),evaluationFlight=useRef(false),metadataFlight=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;evaluationSequence.current++;metadataSequence.current++;};},[]);
  function invalidateEvaluation(){evaluationSequence.current++;metadataSequence.current++;setEvaluation(null);setEvaluationFailed(false);}

  const router=p.provider==='openrouter', gateway=p.provider==='ai_gateway', routeId=useId();
  // 0661: a general gateway's https address; re-checked on save and before every call.
  const [baseUrl,setBaseUrl]=useState(p.gatewayBaseUrl??'');
  const gatewayOptions=gateway&&baseUrl.trim()?{version:1 as const,baseUrl:baseUrl.trim()}:undefined;
  const [routes,setRoutes]=useState(p.providerOptions?.routing.allowedProviders.join('\n')??'');
  const [fallbacks,setFallbacks]=useState(p.providerOptions?.routing.allowFallbacks??false);
  const [sort,setSort]=useState<'price'|'latency'>(p.providerOptions?.routing.sort??'latency');
  const [routeTouched,setRouteTouched]=useState(false);
  let options:OpenRouterOptions|undefined;
  if(router){try{options=readOpenRouterOptions({version:1,routing:{allowedProviders:routes.split(/[\s,]+/).filter(Boolean),allowFallbacks:fallbacks,sort}});}catch{/* shown beside field after blur */}}


  function onTest() {
    if(metadataFlight.current)return;metadataFlight.current=true;const sequence=++metadataSequence.current;
    startTest(async()=>{
      try{const res=await testConnectionAction({provider:p.provider,model,apiKey:key,...(router?{providerOptions:options}:{}),...(gatewayOptions?{providerOptions:gatewayOptions}:{})});
        if(!alive.current||sequence!==metadataSequence.current)return;
        if(res.ok===true)toast.success(t(router?'metadataOk':'testOk'));else toast.error(t('testFail'));
      }catch{if(alive.current&&sequence===metadataSequence.current)toast.error(t('commandFailed'));}
      finally{metadataFlight.current=false;}
    });
  }

  const savedCandidateUnchanged = p.candidateSaved && Boolean(p.candidateId && p.candidateVersion) && key === '' && model === p.model && Boolean(options) &&
    JSON.stringify(options) === JSON.stringify(p.providerOptions);
  const receiptCurrent = evaluation && Date.parse(evaluation.expiresAt) > Math.max(receiptClock,Date.now()) && savedCandidateUnchanged && accountReview && consent && evaluation.candidateId === p.candidateId && evaluation.candidateVersion === p.candidateVersion;
  function onEvaluate() {
    if(evaluationFlight.current||!savedCandidateUnchanged||!accountReview||!consent||!p.candidateId||!p.candidateVersion)return;
    evaluationFlight.current=true;const sequence=++evaluationSequence.current,candidateId=p.candidateId,candidateVersion=p.candidateVersion;
    setEvaluation(null);setEvaluationFailed(false);
    startEvaluation(async()=>{
      try{const result=await evaluateProviderCandidateAction({accountReview:true,consent:true,candidateId,candidateVersion});
        if(!alive.current||sequence!==evaluationSequence.current)return;
        if(result.ok&&result.candidateId===candidateId&&result.candidateVersion===candidateVersion)setEvaluation({receipt:result.receipt,expiresAt:result.expiresAt,candidateId,candidateVersion,summary:result.summary});else setEvaluationFailed(true);
      }catch{if(alive.current&&sequence===evaluationSequence.current)setEvaluationFailed(true);}
      finally{evaluationFlight.current=false;}
    });
  }

  const canSave = (storable || p.configured) && (!router || Boolean(options&&model.trim())) && (!gateway || Boolean(gatewayOptions&&model.trim())); // need the secret set to store a NEW key
  const canTest = !testing && (Boolean(key) || p.isActive || router && p.candidateSaved) && (!router || Boolean(options&&model.trim())) && (!gateway || Boolean(gatewayOptions&&model.trim())); // typed key, or test the active stored key

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{p.label}</h3>
        <div className="flex items-center gap-2">
          {p.isActive && (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              {t('active')}
            </span>
          )}
          {!router && p.pendingSaved && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              {t('pendingBadge')}
            </span>
          )}
          {!p.configured && p.envKeyPresent && (
            <span className="text-[10px] text-muted-foreground">{t('envKeyPresent')}</span>
          )}
        </div>
      </div>

      {router && p.activeModel && <p className="mt-2 text-xs text-muted-foreground">{t('candidateLiveModel', { model: p.activeModel })}</p>}
      <form onSubmit={invalidateEvaluation} action={saveAiProviderConfigAction} className="mt-3 space-y-3">
        <input type="hidden" name="provider" value={p.provider} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('model')}>
            {router||gateway?<input name="model" required value={model} onChange={e=>{invalidateEvaluation();setModel(e.target.value);}}
              autoComplete="off" spellCheck={false} className={inputCls+' min-h-11'} aria-describedby={routeId+'-model-help'}/>:<select name="model" value={model} onChange={(e)=>{invalidateEvaluation();setModel(e.target.value);}} className={inputCls}>
              {p.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>}
            {router&&<p id={routeId+'-model-help'} className="mt-1 text-xs text-muted-foreground">{t('explicitRouterModel')}</p>}
            {gateway&&<p id={routeId+'-model-help'} className="mt-1 text-xs text-muted-foreground">{t('gatewayModelHelp')}</p>}
          </Field>
          <Field label={t('apiKey')}>
            <input
              name="apiKey"
              required={!p.configured}
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => {invalidateEvaluation();setKey(e.target.value);}}
              placeholder={p.configured ? `•••• ${p.keyLast4}` : t('apiKeyPlaceholder')}
              className={inputCls}
            />
          </Field>
        </div>
        {gateway&&<div className="space-y-2">
          <label htmlFor={routeId+'-gateway'} className="text-sm font-medium">{t('gatewayAddress')}</label>
          <input id={routeId+'-gateway'} type="url" inputMode="url" required value={baseUrl} onChange={e=>{invalidateEvaluation();setBaseUrl(e.target.value);}}
            placeholder="https://router.flatkey.ai/v1" autoComplete="off" spellCheck={false} aria-describedby={routeId+'-gateway-help'} className={inputCls+' min-h-11'}/>
          <input type="hidden" name="providerOptions" value={gatewayOptions?JSON.stringify(gatewayOptions):''}/>
          <p id={routeId+'-gateway-help'} className="text-xs text-muted-foreground">{t('gatewayAddressHelp')}</p>
          <button type="button" onClick={()=>{invalidateEvaluation();setBaseUrl('https://router.flatkey.ai/v1');}} className="min-h-11 text-xs font-medium text-primary hover:underline">{t('gatewayPresetFlatkey')}</button>
        </div>}
        {router&&<fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('routingTitle')}</legend>
          <input type="hidden" name="providerOptions" value={options?JSON.stringify(options):''}/>
          <label htmlFor={routeId+'-providers'} className="block text-sm font-medium">{t('approvedProviders')}</label>
          <textarea id={routeId+'-providers'} value={routes} onChange={e=>{invalidateEvaluation();setRoutes(e.target.value);}} onBlur={()=>setRouteTouched(true)}
            required rows={3} maxLength={8192} autoComplete="off" spellCheck={false} className={inputCls}
            aria-invalid={routeTouched&&!options} aria-describedby={routeId+'-route-help'+(routeTouched&&!options?' '+routeId+'-route-error':'')}/>
          <p id={routeId+'-route-help'} className="text-xs text-muted-foreground">{t('approvedProvidersHelp')}</p>
          {routeTouched&&!options&&<p id={routeId+'-route-error'} role="alert" className="text-sm text-destructive">{t('routingInvalid')}</p>}
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={fallbacks}
            onChange={e=>{invalidateEvaluation();setFallbacks(e.target.checked);}} className="size-4"/>{t('boundedFallbacks')}</label>
          <Field label={t('routingPreference')}><select value={sort} onChange={e=>{invalidateEvaluation();setSort(e.target.value as 'price'|'latency');}} className={inputCls+' min-h-11'}>
            <option value="latency">{t('preferLatency')}</option><option value="price">{t('preferPrice')}</option>
          </select></Field>
          <p className="text-xs text-muted-foreground">{t('routingPrivacy')}</p>
          <p className="text-xs text-muted-foreground">{t('metadataOnly')}</p>
          <p className="text-xs text-muted-foreground">{t('accountPluginsReview')}</p>
        </fieldset>}
        {!storable && <p className="text-xs text-amber-600 dark:text-amber-400">{t('notStorable')}</p>}
        {router ? <p className="text-xs text-muted-foreground">{t('candidateSaveNote')}</p> : <p className="text-xs text-muted-foreground">{t('pendingSaveNote')}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!canSave} className={router?'min-h-11':undefined}>
            {t('save')}
          </Button>
          <Button type="button" variant="secondary" onClick={onTest} disabled={!canTest} className={router?'min-h-11':undefined}>
            {testing ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : <PlugZap aria-hidden="true" className="size-3.5" />}
            {testing ? t('testing') : t(router?'metadataTest':'test')}
          </Button>
        </div>
      </form>

      {router && p.candidateSaved && <section className="mt-4 space-y-3 rounded-md border border-border p-3" aria-labelledby={routeId+'-evaluation'}>
        <h4 id={routeId+'-evaluation'} className="text-sm font-medium">{t('evaluationTitle')}</h4>
        <p className="text-xs text-muted-foreground">{t('evaluationExplanation')}</p>
        {!savedCandidateUnchanged && <p className="text-sm">{t('evaluationSaveFirst')}</p>}
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={accountReview}
          onChange={e=>{invalidateEvaluation();setAccountReview(e.target.checked);}} className="size-4"/>{t('evaluationAccountReview')}</label>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={consent}
          onChange={e=>{invalidateEvaluation();setConsent(e.target.checked);}} className="size-4"/>{t('evaluationConsent')}</label>
        <Button type="button" variant="secondary" disabled={evaluating || !savedCandidateUnchanged || !accountReview || !consent} onClick={onEvaluate} className="min-h-11">
          {evaluating && <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none"/>}{t(evaluating?'evaluationRunning':'evaluationRun')}
        </Button>
        <div role="status" aria-live="polite" className="text-sm">
          {evaluationFailed ? t('evaluationFailed') : evaluation ? t(receiptCurrent?'evaluationVerified':'evaluationExpired') : null}
        </div>
        <form action={setActiveProviderAction}>
          <input type="hidden" name="provider" value="openrouter"/>
          <input type="hidden" name="evaluationReceipt" value={receiptCurrent && evaluation ? evaluation.receipt : ''}/>
          <Button type="submit" disabled={!receiptCurrent || evaluating} className="min-h-11">{t('evaluationActivate')}</Button>
        </form>
        {evaluation&&<div className="space-y-1 text-xs text-muted-foreground">
          <p>{t('evaluationElapsed',{value:f.number(evaluation.summary.elapsedMs)})}</p>
          <p>{t('evaluationReportedUsage',{count:evaluation.summary.usageReportedCalls})}</p>
          <p>{t('evaluationCredits',{value:evaluation.summary.accountChargeCredits==null?t('evaluationUnknown'):f.number(evaluation.summary.accountChargeCredits,{maximumSignificantDigits:15})})}</p>
          <p>{t('evaluationAccountingHelp')}</p>
        </div>}
      </section>}
      {p.configured && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {!router && p.pendingSaved && (
            <form action={discardPendingProviderChangeAction}>
              <input type="hidden" name="provider" value={p.provider} />
              <Button type="submit" variant="ghost" size="sm">
                {t('discardPending')}
              </Button>
            </form>
          )}
          <form action={removeAiProviderConfigAction} onSubmit={invalidateEvaluation}>
            <input type="hidden" name="provider" value={p.provider} />
            <Button type="submit" variant="ghost" size="sm">
              <Trash2 className="size-3.5" />
              {t('remove')}
            </Button>
          </form>
        </div>
      )}
    </Card>
  );
}
