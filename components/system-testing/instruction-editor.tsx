'use client';
import { useActionState,useEffect,useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { saveTestingInstructionAction } from '@/app/(app)/admin/system-testing/workspace-actions';
import { INITIAL_TESTING_ACTION_STATE } from '@/lib/system-testing/action-model';
import { TESTING_AREAS,TESTING_CATEGORIES,TESTING_PRIORITIES,TESTING_LIMITS,type InstructionDefinition } from '@/lib/system-testing/model';
import { btnPrimary,inputCls } from '@/components/ui';
export function TestingInstructionEditor({ initial,caseId,versionId,draftRevision,modules,screens }: { initial: InstructionDefinition; caseId: string|null; versionId: string|null; draftRevision: number; modules: { code: string; name: string }[]; screens: { screenKey: string; label: string }[] }) {
  const t=useTranslations('systemTestingWorkspace'),router=useRouter(),[definition,setDefinition]=useState(initial);
  const [opened]=useState({caseId,versionId,revision:draftRevision});
  const encoded=JSON.stringify(definition),tooLarge=new TextEncoder().encode(encoded).byteLength>TESTING_LIMITS.instructionBytes;
  const [state,submit,pending]=useActionState(saveTestingInstructionAction,INITIAL_TESTING_ACTION_STATE);
  const pointer=state.savedDraft??opened;
  useEffect(()=>{if(!opened.caseId&&state.savedDraft&&!state.error)router.replace(`/admin/system-testing/${state.savedDraft.caseId}`);},[opened.caseId,state.savedDraft,state.error,router]);
  function set<K extends keyof InstructionDefinition>(key: K,value: InstructionDefinition[K]) { setDefinition(d=>({...d,[key]:value})); }
  function move(index: number,offset: number) { setDefinition(d=>{ const steps=[...d.steps],target=index+offset; if(target<0||target>=steps.length)return d; [steps[index],steps[target]]=[steps[target],steps[index]]; return {...d,steps}; }); }
  const lineFields=['prerequisites','testData','permissions'] as const;
  return <form action={submit} className="space-y-5">
    <input type="hidden" name="caseId" value={pointer.caseId??''}/><input type="hidden" name="versionId" value={pointer.versionId??''}/><input type="hidden" name="draftRevision" value={pointer.revision}/><input type="hidden" name="definition" value={encoded}/>
    <div className="grid gap-4 sm:grid-cols-2">
      {(['title','objective','functionKey','expectedBehavior','expectedFunction'] as const).map(key=><label key={key} className={key==='title'?'sm:col-span-2':''}><span className="mb-1 block text-sm font-medium">{t(key)}</span><textarea className={`${inputCls} h-auto min-h-20 py-2`} value={definition[key]} maxLength={key==='title'?240:8000} onChange={e=>set(key,e.target.value)}/></label>)}
      <label><span className="mb-1 block text-sm font-medium">{t('area')}</span><select className={inputCls} value={definition.area} onChange={e=>set('area',e.target.value as InstructionDefinition['area'])}>{TESTING_AREAS.map(v=><option key={v} value={v}>{t(`areas.${v}`)}</option>)}</select></label>
      <label><span className="mb-1 block text-sm font-medium">{t('module')}</span><select className={inputCls} value={definition.moduleCode} onChange={e=>set('moduleCode',e.target.value)}><option value="">{t('choose')}</option>{modules.map(v=><option key={v.code} value={v.code}>{v.name}</option>)}</select></label>
      <label><span className="mb-1 block text-sm font-medium">{t('category')}</span><select className={inputCls} value={definition.category} onChange={e=>set('category',e.target.value as InstructionDefinition['category'])}>{TESTING_CATEGORIES.map(v=><option key={v} value={v}>{t(`categories.${v}`)}</option>)}</select></label>
      <label><span className="mb-1 block text-sm font-medium">{t('priority')}</span><select className={inputCls} value={definition.priority} onChange={e=>set('priority',e.target.value as InstructionDefinition['priority'])}>{TESTING_PRIORITIES.map(v=><option key={v} value={v}>{t(`priorities.${v}`)}</option>)}</select></label>
      {(['jurisdiction','configuration'] as const).map(key=><label key={key}><span className="mb-1 block text-sm font-medium">{t(key)}</span><textarea className={`${inputCls} h-auto min-h-20 py-2`} value={definition[key]??''} onChange={e=>set(key,e.target.value||null)}/></label>)}
      <label className="flex items-center gap-2"><input type="checkbox" checked={definition.active} onChange={e=>set('active',e.target.checked)}/>{t('active')}</label>
    </div>
    {lineFields.map(key=><label key={key} className="block"><span className="mb-1 block text-sm font-medium">{t(key)}</span><textarea className={`${inputCls} h-auto min-h-20 py-2`} rows={3} value={definition[key].join('\n')} onChange={e=>set(key,e.target.value.split('\n'))}/><span className="text-xs text-muted-foreground">{t('onePerLine')}</span></label>)}
    <label className="block"><span className="mb-1 block text-sm font-medium">{t('screens')}</span><select multiple className={`${inputCls} h-auto min-h-40`} size={6} value={definition.screenKeys} onChange={e=>set('screenKeys',Array.from(e.target.selectedOptions,o=>o.value))}>{screens.map(v=><option key={v.screenKey} value={v.screenKey}>{v.label}</option>)}</select></label>
    <fieldset className="space-y-3"><legend className="text-base font-semibold">{t('steps')}</legend>{definition.steps.map((step,index)=><div key={step.id} className="rounded-lg border border-border p-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{t('stepNumber',{number:index+1})}</span><div className="flex gap-2">{([-1,1] as const).map(offset=><button key={offset} type="button" disabled={index+offset<0||index+offset>=definition.steps.length} className="rounded border px-2 py-1 text-sm disabled:opacity-40" onClick={()=>move(index,offset)} aria-label={t(offset<0?'moveUp':'moveDown',{number:index+1})}>{t(offset<0?'up':'down')}</button>)}<button type="button" className="rounded border px-2 py-1 text-sm" onClick={()=>set('steps',definition.steps.filter(s=>s.id!==step.id))}>{t('remove')}</button></div></div><div className="grid gap-3 sm:grid-cols-2">{(['action','expected'] as const).map(key=><label key={key}><span className="mb-1 block text-sm">{t(key)}</span><textarea className={`${inputCls} h-auto min-h-20 py-2`} value={step[key]} onChange={e=>set('steps',definition.steps.map(s=>s.id===step.id?{...s,[key]:e.target.value}:s))}/></label>)}</div></div>)}<button type="button" className="rounded border px-3 py-2 text-sm" disabled={definition.steps.length>=TESTING_LIMITS.steps} onClick={()=>{let n=1;while(definition.steps.some(s=>s.id===`step${n}`))n++;set('steps',[...definition.steps,{id:`step${n}`,action:'',expected:''}]);}}>{t('addStep')}</button></fieldset>
    {tooLarge&&<p role="alert" className="text-sm text-destructive">{t('errors.limit')}</p>}
    {state.error&&<p role="alert" className="break-words text-sm text-destructive">{t(`errors.${state.error}`)}</p>}
    <div className="flex flex-wrap gap-3"><button className={btnPrimary} type="submit" name="intent" value="draft" disabled={pending||tooLarge}>{pending?t('saving'):t('saveDraft')}</button><button className="rounded-md border px-4 py-2 text-sm font-medium" type="submit" name="intent" value="publish" disabled={pending||tooLarge}>{t('savePublish')}</button></div>
    <p className="text-sm text-muted-foreground">{t('publishNote')}</p>
  </form>;
}
