'use client';
import type { KpiLibraryChoice } from '@/packs/performance/onehr/setting-default-model';
import { readKpiSettingForm } from '@/packs/performance/onehr/setting-form-model';
import { applyLibraryTarget } from '@/packs/performance/onehr/setting-command-model';
import { useTranslations } from 'next-intl';
import { AssessmentDraftForm } from './draft-form';
import { useState } from 'react';
import { Button, Field, inputCls } from '@/components/ui';
import type { KPI } from '@/packs/performance/onehr/model';
import { saveAssessmentKpiSettingAction,onehrReviewAction } from '../onehr-actions';
type Labels=Record<string,string>;
export function KpiEditor({reviewId,revision,kpis,moderators,reviewerEmploymentId,mechanism,variant='base',labels:t,returnTo,library=[]}:{reviewId:string;revision:number;kpis:KPI[];moderators:{id:string;name:string}[];reviewerEmploymentId:string|null;mechanism:'A'|'B';variant?:'base'|'excellence';labels:Labels;returnTo?:string;library?:KpiLibraryChoice[]}){
  const copy=useTranslations('onehr');
  const [rows,setRows]=useState(kpis);
  const [epoch,setEpoch]=useState(0),[generationError,setGenerationError]=useState('');
  const [selected,setSelected]=useState('');
  function addFromLibrary(){const item=library.find(l=>l.id===selected);if(!item)return;setRows(rows=>[...rows,{id:crypto.randomUUID(),libraryId:item.id,title:item.title,category:item.category,description:item.description,unit:item.unit,weightBp:item.weightBp??0,scoring:item.defaultScoring??item.scoring,numberSource:item.numberSource??'library',moderatorEmploymentId:reviewerEmploymentId,setting:'draft',settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false}]);setSelected('');}
  const add=()=>setRows(r=>[...r,{id:crypto.randomUUID(),title:'',description:'',weightBp:1000,unit:'',moderatorEmploymentId:null,scoring:mechanism==='A'?{mechanism:'A',method:'more',rates:[null,null,null,null,null]}:{mechanism:'B',method:'more',variant,threshold:null,target:null,multiple:null,excellence:null},setting:'draft',settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false}]);
  function generate(id:string,form:HTMLFormElement|null){
   if(!form)return;
   try{
    const inputs=readKpiSettingForm(new FormData(form),reviewerEmploymentId),next=rows.map(k=>({...k,...inputs.find(i=>i.id===k.id)})),k=next.find(k=>k.id===id)!;
    const base=k.scoring.target;if(base==null)throw Error('Missing target.');
    k.scoring=applyLibraryTarget(k,library.find(l=>l.id===k.libraryId),base);k.numberSource='spread';setRows(next);setEpoch(e=>e+1);setGenerationError('');
   }catch{setGenerationError(copy('generateTargetsFailed'));}
  }
  const assigned=(k:KPI)=>k.moderatorEmploymentId??reviewerEmploymentId??'';
  return <AssessmentDraftForm revision={revision} changeKey={`${rows.map(k=>k.id).join('|')}.${epoch}`} save={saveAssessmentKpiSettingAction} action={async data=>{data.set('revision',String(data.get('draftRevision')));await onehrReviewAction(data);}} labels={{saving:copy('settingDraftSaving'),saved:copy('settingDraftSaved'),privateDraft:copy('settingDraftHelp'),failed:copy('draftFailed')}} className="space-y-5">{returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}<input type="hidden" name="action" value="kpis"/><input type="hidden" name="reviewId" value={reviewId}/><input type="hidden" name="revision" value={revision}/>
    {generationError&&<p role="alert" className="text-sm text-destructive">{generationError}</p>}
    {library.length>0&&<div className="flex flex-wrap items-end gap-3"><Field label={t.library}><select className={inputCls} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">{t.choose}</option>{library.map(l=><option key={l.id} value={l.id}>{l.title}</option>)}</select></Field><Button type="button" variant="secondary" disabled={!selected||rows.some(k=>k.libraryId===selected||k.title===library.find(l=>l.id===selected)?.title)} onClick={addFromLibrary}>{t.addFromLibrary}</Button></div>}
    {rows.map(k=><fieldset id={`kpi-${k.id}`} key={`${k.id}.${epoch}`} className="space-y-4 rounded-lg border border-border p-4"><input type="hidden" name="kpiId" value={k.id}/><input type="hidden" name={`${k.id}.libraryId`} value={k.libraryId??''}/><input type="hidden" name={`${k.id}.category`} value={k.category??''}/><legend className="px-1 font-medium">{t.kpi}</legend>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={t.title}><input required maxLength={300} name={`${k.id}.title`} defaultValue={k.title} className={inputCls}/></Field><Field label={t.weight}><input required type="number" min="0" max="100" step="0.01" name={`${k.id}.weight`} defaultValue={k.weightBp/100} className={inputCls}/></Field></div>
      {k.numberSource&&<p className="text-xs text-muted-foreground">{copy(`numberSources.${k.numberSource}`)}</p>}
      <Field label={t.moderator}><input type="hidden" name={`${k.id}.moderator`} value={assigned(k)}/><p className="py-2 text-sm">{moderators.find(m=>m.id===assigned(k))?.name??t.choose}</p></Field><Field label={t.description}><textarea name={`${k.id}.description`} maxLength={4000} defaultValue={k.description} className={inputCls}/></Field>
      <div className="grid gap-4 sm:grid-cols-3"><Field label={t.unit}><input name={`${k.id}.unit`} maxLength={80} defaultValue={k.unit} className={inputCls}/></Field><Field label={t.mechanism}><input type="hidden" name={`${k.id}.mechanism`} value={mechanism}/><p className="py-2">{mechanism==='A'?t.mechanismA:t.mechanismB}</p></Field><Field label={t.direction}><select name={`${k.id}.method`} defaultValue={k.scoring.method} className={inputCls}><option value="more">{t.more}</option><option value="less">{t.less}</option></select></Field></div>
      {k.scoring.mechanism==='A'?<><Field label={t.target}><input type="number" step="any" name={`${k.id}.target`} defaultValue={k.scoring.target??''} className={inputCls}/></Field><div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{k.scoring.rates.map((n,i)=><Field key={i} label={`${t.threshold} ${i+1}`}><input required type="number" step="any" name={`${k.id}.rate.${i}`} defaultValue={n??''} className={inputCls}/></Field>)}</div></>:<div className="grid gap-3 sm:grid-cols-3"><Field label={t.variant}><input type="hidden" name={`${k.id}.variant`} value={variant}/><p className="py-2 text-sm">{t[variant]}</p></Field>{(['threshold','target',...(variant==='base'?['multiple' as const]:['excellence' as const])] as const).map(key=><Field key={key} label={t[key]}><input required={key!=='multiple'} type="number" step="any" name={`${k.id}.${key}`} defaultValue={k.scoring.mechanism==='B'?k.scoring[key]??'':''} className={inputCls}/></Field>)}</div>}
      {library.find(l=>l.id===k.libraryId)?.spread&&<Button type="button" variant="secondary" onClick={e=>generate(k.id,e.currentTarget.form)}>{copy('generateTargets')}</Button>}
      <Button type="button" variant="secondary" onClick={()=>setRows(r=>r.filter(x=>x.id!==k.id))}>{t.remove}</Button>
    </fieldset>)}
    <p className="text-sm text-muted-foreground">{t.weightHelp}</p><div className="flex flex-wrap gap-3"><Button type="button" variant="secondary" onClick={add}>{t.addKpi}</Button><Button type="submit" formNoValidate variant="secondary">{t.saveDraft}</Button><Button type="submit" name="propose" value="true" disabled={!rows.length}>{t.propose}</Button></div>
  </AssessmentDraftForm>;
}
