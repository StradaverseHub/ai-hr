'use client';
import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { btnPrimary, inputCls } from '@/components/ui';
import { emptyOperatorState, type OperatorActionState } from './action-state';
import { submitCustomerAction,renameCustomerAction,changeCustomerModuleAction,setCustomerFeedbackMenuAction } from './actions';
import type { CustomerModule } from '@/core/operator-customers';
import type { DeactivationBlocker } from '@/core/module-deactivation';

type ModuleOption={code:string;name:string;description:string;dependsOn:string[];billable:boolean};
function Result({state,success}:{state:OperatorActionState;success:string}) {
  return state.error?<p role="alert" className="text-sm text-destructive">{state.error}</p>
    :state.ok?<p role="status" className="text-sm text-foreground">{success}</p>:null;
}
export function CustomerCreateForm({countries,modules,defaults,coreNames,internalAuth}:{internalAuth:boolean;countries:string[];modules:ModuleOption[];defaults:readonly string[];coreNames:string}) {
  const t=useTranslations('operator'),w=useTranslations('operatorWorkspace');
  const [state,action,pending]=useActionState(submitCustomerAction,emptyOperatorState);
  return <form action={action} className="mt-4 space-y-5">
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm font-medium">{t('customerName')}<input name="customerName" required maxLength={200} className={inputCls}/></label>
      {internalAuth&&<label className="space-y-1 text-sm font-medium">{w('organizationCode')}<input name="organizationCode" required minLength={2} maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,63}" autoCapitalize="none" spellCheck={false} className={inputCls}/><span className="block text-xs font-normal text-muted-foreground">{w('codeHelp')}</span></label>}
      <label className="space-y-1 text-sm font-medium">{t('adminEmail')}<input name="adminEmail" type="email" required maxLength={255} className={inputCls}/></label>
      <label className="space-y-1 text-sm font-medium">{w('country')}<select name="country" defaultValue="MY" className={inputCls}>{countries.map(c=><option key={c}>{c}</option>)}</select></label>
    </div>
    <fieldset><legend className="mb-2 text-sm font-medium">{w('modules')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">{modules.map(m=><label key={m.code} className="flex items-start gap-3 rounded-lg p-2 hover:bg-muted/50">
        <input type="checkbox" name="modules" value={m.code} defaultChecked={defaults.includes(m.code)} className="mt-1 size-4 shrink-0 accent-primary"/>
        <span className="text-sm"><span className="font-medium">{m.name}</span>{' '}<span className="mt-0.5 block text-xs text-muted-foreground">{m.description}</span></span>
      </label>)}</div><p className="mt-3 text-xs text-muted-foreground">{w('coreIncluded',{modules:coreNames})}</p>
    </fieldset>
    <Result state={state} success={w('creationQueued')}/>
    <button disabled={pending} type="submit" className={btnPrimary}>{pending?w('saving'):t('create')}</button>
  </form>;
}
export function CustomerNameForm({tenantId,name}:{tenantId:string;name:string}) {
  const w=useTranslations('operatorWorkspace'),t=useTranslations('operator');
  const [state,action,pending]=useActionState(renameCustomerAction,emptyOperatorState);
  return <form action={action} className="space-y-3"><input type="hidden" name="tenantId" value={tenantId}/>
    <label className="block space-y-1 text-sm font-medium">{t('customerName')}<input name="customerName" required maxLength={200} defaultValue={name} className={inputCls}/></label>
    <p className="text-xs text-muted-foreground">{w('nameHelp')}</p>
    <Result state={state} success={w('saved')}/><button type="submit" className={btnPrimary} disabled={pending}>{pending?w('saving'):w('saveName')}</button>
  </form>;
}
export function CustomerModuleForm({tenantId,modules,grants,blockers,busy}:{tenantId:string;modules:ModuleOption[];grants:CustomerModule[];blockers:Record<string,DeactivationBlocker[]>;busy:boolean}) {
  const w=useTranslations('operatorWorkspace');
  const [selected,setSelected]=useState('');
  const [state,action,pending]=useActionState(changeCustomerModuleAction,emptyOperatorState);
  const module=modules.find(m=>m.code===selected);
  const current=grants.find(m=>m.code===selected&&m.companyId===null);
  const enabled=!!current&&['active','trial'].includes(current.status);
  const scoped=grants.some(m=>m.code===selected&&m.companyId!==null);
  const active=new Set(grants.filter(g=>g.companyId===null&&['active','trial'].includes(g.status)).map(g=>g.code));
  const optional=new Set(modules.map(m=>m.code));
  const missing=module?.dependsOn.filter(code=>optional.has(code)&&!active.has(code))??[];
  const dependents=modules.filter(m=>m.dependsOn.includes(selected)&&grants.some(g=>g.code===m.code&&['active','trial'].includes(g.status)));
  const held=enabled?(blockers[selected]??[]):[];
  const blocked=scoped||(!enabled&&missing.length>0)||(enabled&&dependents.length>0);
  const names=(codes:string[])=>codes.map(c=>modules.find(m=>m.code===c)?.name??c).join(', ');
  return <form action={action} onReset={()=>setSelected('')} className="space-y-4">
    <input type="hidden" name="tenantId" value={tenantId}/><input type="hidden" name="action" value={enabled?'deactivate':'activate'}/>
    {busy&&<p role="status" className="text-sm text-muted-foreground">{w('pendingHelp')}</p>}
    <label className="block space-y-1 text-sm font-medium">{w('selectModule')}<select name="moduleCode" required className={inputCls} value={selected} onChange={e=>setSelected(e.target.value)} disabled={busy||pending}>
      <option value="">{w('selectModule')}</option>{modules.map(m=><option key={m.code} value={m.code}>{m.name}</option>)}
    </select></label>
    {module&&<div key={selected} className="space-y-3">
      <p className="text-sm text-muted-foreground">{module.description}</p>
      {scoped&&<p role="alert" className="text-sm">{w('scopedHelp')}</p>}
      {missing.length>0&&!enabled&&<p role="alert" className="text-sm">{w('requires',{modules:names(missing)})}</p>}
      {dependents.length>0&&enabled&&<p role="alert" className="text-sm">{w('dependentHelp',{modules:dependents.map(m=>m.name).join(', ')})}</p>}
      {!enabled&&module.billable&&!blocked&&<label className="block space-y-1 text-sm font-medium">{w('purchaseReference')}<input name="purchaseReference" required minLength={3} maxLength={500} className={inputCls}/><span className="block text-xs font-normal text-muted-foreground">{w('purchaseHelp')}</span></label>}
      {enabled&&<p className="text-sm">{w('disableHelp')}</p>}
      {held.map(b=><label key={b.kind} className="block space-y-2 text-sm"><span className="block font-medium">{b.detail}</span><span className="block text-muted-foreground">{w('dispositionHelp')}</span><textarea name={`disposition:${b.kind}`} required minLength={3} maxLength={1000} rows={3} className={`${inputCls} min-h-24 py-2`}/></label>)}
      <button type="submit" className={btnPrimary} disabled={busy||pending||blocked}>{pending?w('saving'):enabled?w('disable'):w('enable')}</button>
    </div>}
    <Result state={state} success={w('changeQueued')}/>
  </form>;
}
export function CustomerFeedbackMenuForm({tenantId,enabled}:{tenantId:string;enabled:boolean}) {
  const w=useTranslations('operatorWorkspace');
  const [state,action,pending]=useActionState(setCustomerFeedbackMenuAction,emptyOperatorState);
  return <form action={action} className="space-y-3"><input type="hidden" name="tenantId" value={tenantId}/><input type="hidden" name="enabled" value={String(!enabled)}/>
    <p className="text-sm text-muted-foreground">{w(enabled?'feedbackMenuOnHelp':'feedbackMenuOffHelp')}</p>
    <Result state={state} success={w('feedbackMenuSaved')}/><button type="submit" className={btnPrimary} disabled={pending}>{pending?w('saving'):w(enabled?'feedbackMenuHide':'feedbackMenuShow')}</button>
  </form>;
}
