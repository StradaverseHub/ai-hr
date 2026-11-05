'use client';
/** Feedback 02472802 round 2: Formula Help & Examples, the plain-language explanation, checks before
 * saving and the sample-value test. Everything here is advisory or read-only: saving still goes through
 * saveFormulaAction and activation still needs the saved revision's employee test. */
import {useMemo,useRef,useState,type ReactNode} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {personnelFormulaFieldDescriptor} from '@/lib/pay-formula-personnel';
import {parsePayFormula,type FormulaValue} from '@/lib/pay-formula-language';
import {explainPayFormula,type FormulaExplanationWords} from '@/lib/pay-formula-explain';
import {PAY_FORMULA_TEMPLATE_KEYS,payFormulaTemplateSource,type PayFormulaTemplateKey} from '@/lib/pay-formula-templates';
import type {FormulaDiagnostic} from '@/lib/pay-formula-diagnostics';
import {PAY_FORMULA_SAMPLE_VARIABLES,payFormulaSampleFields,type PayFormulaSampleResult,type PayFormulaSampleStep,type PayFormulaSampleValues,type PayFormulaSampleVariable} from '@/lib/pay-formula-sample';
import {sampleFormulaAction} from './actions';
import {formulaInput,formulaButton,formulaPrimary} from './ui-types';

export type FormulaHelpTab='examples'|'variables'|'operators'|'conditions'|'returnExplain';
const HELP_TABS:readonly FormulaHelpTab[]=['examples','variables','operators','conditions','returnExplain'];
const KEY_VARIABLES=['Basic','FixedAllowances','CalendarDays','Input','Rate','PayItemInput'] as const;
const OPERATORS=[['+','add'],['-','subtract'],['*','multiply'],['/','divide'],['( )','brackets'],['= <> < <= > >=','compare'],['And','and'],['Or','or'],['Not','not'],['&','join']] as const;
const code='rounded bg-muted px-1.5 py-0.5 font-mono text-xs';

function useTemplateNote(){const t=useTranslations('payFormula');return t('templates.hourlyRateNote');}
export function useFormulaTemplateSource(){const note=useTemplateNote();return (key:PayFormulaTemplateKey)=>payFormulaTemplateSource(key,note);}

export function FormulaHelpPanel({tab,onTab,library,canUseTemplate}:{tab:FormulaHelpTab;onTab:(tab:FormulaHelpTab)=>void;library:ReactNode;canUseTemplate:boolean}){
 const t=useTranslations('payFormula'),templateSource=useFormulaTemplateSource();const [preview,setPreview]=useState<PayFormulaTemplateKey|null>(null);
 const pane=(name:FormulaHelpTab)=>({role:'tabpanel' as const,id:'formula-help-'+name,'aria-labelledby':'formula-help-tab-'+name,hidden:tab!==name,className:'space-y-4'});
 return <aside className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="formula-help-title">
  <div><h2 id="formula-help-title" className="font-semibold">{t('help.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('help.subtitle')}</p></div>
  <div role="tablist" aria-label={t('help.title')} className="flex flex-wrap gap-2">{HELP_TABS.map(name=><button key={name} id={'formula-help-tab-'+name} type="button" role="tab" aria-selected={tab===name} aria-controls={'formula-help-'+name} className={tab===name?formulaPrimary:formulaButton} onClick={()=>onTab(name)}>{t('help.tabs.'+name)}</button>)}</div>
  <div {...pane('examples')}>
   <p className="text-sm text-muted-foreground">{t('help.examplesIntro')}</p>
   <ul className="space-y-3">{PAY_FORMULA_TEMPLATE_KEYS.map(key=>{const open=preview===key;return <li key={key} className={'rounded-lg border p-3 '+(open?'border-primary':'border-border')}>
    <div className="flex flex-col items-start justify-between gap-3 sm:flex-row"><div className="min-w-0 flex-1"><h3 className="font-medium">{t('templates.'+key+'.name')}</h3><p className="text-sm text-muted-foreground">{t('templates.'+key+'.summary')}</p></div>
     <div className="flex flex-wrap gap-2"><button type="button" className={formulaButton} aria-expanded={open} aria-controls={'formula-template-'+key} onClick={()=>setPreview(open?null:key)}>{t(open?'help.hidePreview':'help.preview')}<span className="sr-only"> · {t('templates.'+key+'.name')}</span></button>
      {canUseTemplate&&<Link className={formulaPrimary} href={'/payroll/formula-builder/new?template='+key}>{t('help.useTemplate')}<span className="sr-only"> · {t('templates.'+key+'.name')}</span></Link>}</div></div>
    {open&&<div id={'formula-template-'+key} className="mt-3 space-y-2"><pre className="overflow-x-auto whitespace-pre rounded-lg bg-muted p-3 font-mono text-xs leading-5">{templateSource(key)}</pre><p className="text-sm">{t('templates.'+key+'.explanation')}</p></div>}
   </li>;})}</ul>
   <p className="text-xs text-muted-foreground">{t('help.templateNote')}</p>
   <dl className="divide-y divide-border text-sm">{KEY_VARIABLES.map(name=><div key={name} className="flex flex-wrap gap-x-2 gap-y-1 py-2"><dt><code className={code}>{'{#'+name+'}'}</code></dt><dd>{t('functionHelp.'+name)}</dd></div>)}</dl>
  </div>
  <div {...pane('variables')}><p className="text-sm text-muted-foreground">{t('help.variablesIntro')}</p><p className="text-sm text-muted-foreground">{t('help.typedIntro')}</p>{library}</div>
  <div {...pane('operators')}><p className="text-sm text-muted-foreground">{t('help.operatorsIntro')}</p><dl className="divide-y divide-border text-sm">{OPERATORS.map(([symbol,name])=><div key={name} className="flex flex-wrap gap-x-2 gap-y-1 py-2"><dt><code className={code}>{symbol}</code></dt><dd>{t('help.operators.'+name)}</dd></div>)}</dl><p className="text-sm">{t('help.operatorsOrder')}</p><pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{'Return ({#Basic} + {#FixedAllowances}) / 26 / 8 * 1.5 * {#Input}'}</pre></div>
  <div {...pane('conditions')}><p className="text-sm">{t('help.conditionsIntro')}</p><pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5">{'If {#Basic} <= 4000 Then\n    Return {#Basic} / 26 * {#Input}\nElseIf {#Basic} <= 6000 Then\n    Return 100\nElse\n    Return 0\nEnd If'}</pre><p className="text-sm text-muted-foreground">{t('help.conditionsRules')}</p></div>
  <div {...pane('returnExplain')}><p className="text-sm">{t('help.returnIntro')}</p><pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{'Return {#Basic} / {#CalendarDays} * {#Input}'}</pre><p className="text-sm">{t('help.explainIntro')}</p><pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{'{#Explain}("Daily rate: " & {#Basic} / {#CalendarDays})'}</pre><p className="text-sm">{t('help.dimIntro')}</p><pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{'Dim Gross As Decimal = {#Basic} + {#FixedAllowances}'}</pre><p className="text-sm text-muted-foreground">{t('help.commentIntro')}</p></div>
 </aside>;
}

export function FormulaExplanation({text,templateKey}:{text:string;templateKey?:PayFormulaTemplateKey}){
 const t=useTranslations('payFormula'),templateSource=useFormulaTemplateSource();
 const words:FormulaExplanationWords=useMemo(()=>({and:t('explain.and'),or:t('explain.or'),not:t('explain.not'),true:t('true'),false:t('false'),variable:code=>t('functions.'+code)}),[t]);
 const lines=useMemo(()=>{try{return explainPayFormula(parsePayFormula(text),words);}catch{return null;}},[text,words]);
 const curated=templateKey&&text===templateSource(templateKey);
 return <section aria-labelledby="formula-explanation-title" className="rounded-lg border border-amber-300/70 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
  <h3 id="formula-explanation-title" className="font-semibold">{t('explain.title')}</h3>
  {curated?<p className="mt-1">{t('templates.'+templateKey+'.explanation')}</p>:lines?<ul className="mt-1 space-y-1">{lines.map((line,index)=><li key={index} style={{paddingInlineStart:line.depth*1.25+'rem'}}>{t('explain.'+line.key,line.values)}</li>)}</ul>:<p className="mt-1">{t('explain.unavailable')}</p>}
 </section>;
}

export function FormulaChecks({diagnostics,onSelect}:{diagnostics:readonly FormulaDiagnostic[];onSelect?:(diagnostic:FormulaDiagnostic)=>void}){
 const t=useTranslations('payFormula');
 const message=(d:FormulaDiagnostic)=>{
  if(d.code==='unknown_function'||d.code==='unknown_variable')return t(d.suggestion?'checks.'+d.code+'Suggest':'checks.'+d.code,{name:d.name??'',suggestion:d.suggestion??''});
  if(d.code==='missing_return'||d.code==='division_by_zero')return t('checks.'+d.code);
  if(d.code==='possible_zero_divisor')return t('checks.possible_zero_divisor',{name:d.name??''});
  return d.message;
 };
 return <section aria-labelledby="formula-checks-title" className="space-y-2">
  <h3 id="formula-checks-title" className="font-semibold">{t('checks.title')}</h3>
  {diagnostics.length?<ul className="space-y-2">{diagnostics.map((d,index)=>{const tone=d.severity==='error'?'border-destructive/40 bg-destructive/5 text-destructive':'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100';const body=<><span className="block font-semibold">{t(d.severity==='error'?'checks.error':'checks.warning',{line:d.line,column:d.column})}</span><span className="block">{message(d)}</span></>;
   return <li key={index}>{onSelect?<button type="button" className={'block w-full rounded-lg border p-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring '+tone} onClick={()=>onSelect(d)}>{body}</button>:<div className={'rounded-lg border p-3 text-sm '+tone}>{body}</div>}</li>;})}</ul>:<p className="text-sm text-muted-foreground">{t('checks.none')}</p>}
  {diagnostics.length>0&&<p className="text-xs text-muted-foreground">{t('checks.help')}</p>}
 </section>;
}

const SYMBOL:Readonly<Record<string,string>>={'*':'×','/':'÷','+':'+','-':'−'};
const shown=(value:FormulaValue)=>value.type==='boolean'?String(value.value):value.value;
export function FormulaSampleTest({text}:{text:string}){
 const t=useTranslations('payFormula'),labels=useTranslations(),busy=useRef(false);
 const [values,setValues]=useState<PayFormulaSampleValues>({}),[result,setResult]=useState<PayFormulaSampleResult|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
 const [resultKey,setResultKey]=useState('');
 const inputKey=JSON.stringify([text,values]);
 const fields=payFormulaSampleFields(text);
 const fieldLabel=(field:typeof fields[number])=>{if(t.has('generator.fields.'+field.field))return t('generator.fields.'+field.field);const descriptor=personnelFormulaFieldDescriptor(field.code,field.field);return descriptor&&labels.has(descriptor.labelKey)?labels(descriptor.labelKey):descriptor?.label??field.field;};
 const visible=PAY_FORMULA_SAMPLE_VARIABLES.filter(name=>['Basic','FixedAllowances','CalendarDays','Input'].includes(name)||new RegExp('\\{#'+name+'\\}','i').test(text));
 async function run(){
  if(busy.current)return;const requestKey=inputKey;busy.current=true;setPending(true);setError('');
  try{const clean:PayFormulaSampleValues=fields.length?{fields:values.fields}:{};for(const name of visible){const raw=values[name];if(raw!==undefined&&raw.trim()!=='')clean[name]=raw.replace(/,/g,'').trim();}
   const response=await sampleFormulaAction({source:text,values:clean});setResultKey(requestKey);if(!response.ok){setResult(null);setError(response.error);return;}setResult(response.value);}
  catch{setResult(null);setResultKey(requestKey);setError(t('testArea.failed'));}
  finally{busy.current=false;setPending(false);}
 }
 const step=(s:PayFormulaSampleStep)=>{
  switch(s.kind){
   case 'read':return t('testArea.step.read',{name:t('functions.'+s.code),value:shown(s.value)});
   case 'set':return t('testArea.step.set',{name:s.name,value:shown(s.value)});
   case 'arithmetic':return t('testArea.step.arithmetic',{left:s.left,operator:SYMBOL[s.operator]??s.operator,right:s.right,result:s.result});
   case 'condition':return t(s.value?'testArea.step.conditionTrue':'testArea.step.conditionFalse',{line:s.loc.line});
   case 'otherwise':return t('testArea.step.otherwise',{line:s.loc.line});
   case 'explain':return t('testArea.step.explain',{text:s.text});
   case 'return':return t('testArea.step.return',{value:shown(s.value)});
  }
 };
 const shownResult=resultKey===inputKey?result:null;
 const failure=shownResult?.error;
 return <div className="space-y-4">
  <p className="text-sm text-muted-foreground">{t('testArea.sampleHelp')}</p>
  <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">{visible.map((name:PayFormulaSampleVariable)=><label key={name} className="text-sm">{t('testArea.fields.'+name)}<input className={formulaInput} inputMode="decimal" value={values[name]??''} onChange={event=>setValues({...values,[name]:event.target.value})}/></label>)}</fieldset>
  {fields.length>0&&<fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">{fields.map(field=><label key={field.key} className="text-sm">{fieldLabel(field)}<input className={formulaInput} type={field.type==='date'?'date':'text'} maxLength={500} value={values.fields?.[field.key]??''} onChange={event=>setValues({...values,fields:{...values.fields,[field.key]:event.target.value}})}/></label>)}</fieldset>}
  <button type="button" className={formulaPrimary} disabled={pending||!text.trim()} onClick={run}>{pending?t('working'):t('testArea.run')}</button>
  {error&&resultKey===inputKey&&<p className="text-sm text-destructive">{error}</p>}
  {shownResult&&<div role="status" className="space-y-3">
   <span className={'inline-block rounded-full px-3 py-1 text-sm '+(shownResult.passed?'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200':'bg-destructive/10 text-destructive')}>{t(shownResult.passed?'testArea.passed':'testArea.failed')}</span>
   {shownResult.payable!==null&&<div><p className="text-3xl font-semibold tabular-nums">{shownResult.payable}</p><p className="text-xs text-muted-foreground">{t('testArea.payableHelp')}</p>{shownResult.amount!==shownResult.payable&&<p className="text-xs text-muted-foreground">{t('testArea.exact',{value:shownResult.amount??''})}</p>}</div>}
   {failure&&<p className="text-sm text-destructive">{failure.code==='calculation'?failure.message:t('testArea.errors.'+failure.code,{variable:failure.variable?t('functions.'+failure.variable):'',line:failure.line??1,column:failure.column??1,message:failure.message})}</p>}
   {shownResult.steps.length>0&&<div><h4 className="text-sm font-medium">{t('testArea.stepsTitle')}</h4><ol className="mt-2 list-decimal space-y-1 ps-6 text-sm tabular-nums">{shownResult.steps.map((s,index)=><li key={index}>{step(s)}</li>)}</ol>{shownResult.stepsTruncated&&<p className="mt-1 text-xs text-muted-foreground">{t('testArea.truncated',{count:shownResult.steps.length})}</p>}</div>}
  </div>}
  <p className="text-xs text-muted-foreground">{t('testArea.note')}</p>
 </div>;
}
