'use client';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useMessages,useTranslations} from 'next-intl';
import type {ProbationLetterDefinition,ProbationTemplate,ProbationAdministrationOptions} from '@/packs/probation/service';
import type {TemplateVersion} from '@/lib/lifecycle-v9-model';
import {newProbationLetterTemplate,PROBATION_LETTER_KEYS} from '@/lib/probation-letter-template';
import {TemplateVersionEditor,type TemplateEditorLabels} from '../../v9/template-version-editor';
import {PreparationNav} from '../preparation-nav';
import {RouteFields} from '../route-fields';
import {RetireVersionControl} from '../retire-version-control';
import {DraftGuard} from '../draft-guard';
import {saveLetterTemplate} from '../actions';
export function TemplateWorkspace({company,companies,definitions,ruleOptions}:{company:{id:string;name:string};companies:{id:string;name:string}[];definitions:ProbationLetterDefinition[];ruleOptions:Pick<ProbationAdministrationOptions,'businessGroups'|'businessUnits'|'departments'|'grades'>}){
 const editorLabels=useMessages().templateEditor as TemplateEditorLabels;
 const t=useTranslations('probation'),router=useRouter(),[selected,setSelected]=useState<ProbationTemplate|null>(null),[dirty,setDirty]=useState(false),[retirementDirty,setRetirementDirty]=useState(false),[busy,start]=useTransition(),[error,setError]=useState('');
 const latest=definitions.filter((d,i,a)=>i===a.findIndex(other=>other.key===d.key));
 const current=selected?latest.find(d=>d.key===selected.id):undefined;
 const publication=selected?definitions.find(d=>d.key===selected.id&&['published','retired'].includes(d.state)):undefined;
 const update=(patch:Partial<ProbationTemplate>)=>{setSelected(v=>v?{...v,...patch}:v);setDirty(true);};
 const choose=(outcome:ProbationTemplate['outcome'],stored?:ProbationLetterDefinition)=>{if((dirty||retirementDirty)&&!window.confirm(t('leaveUnsaved')))return;setSelected(stored?structuredClone(stored.data):newProbationLetterTemplate(outcome,crypto.randomUUID(),t('outcomes.'+outcome)));setDirty(false);setError('');};
 const setRule=(key:string,values:string[])=>selected&&update({rules:{...selected.rules,[key]:values.length?values:undefined}});
 const rule=(key:string)=>(selected?.rules as Record<string,string[]|undefined>|undefined)?.[key]??[];

 const save=(publish:boolean)=>{if(!selected)return;setError('');start(async()=>{const result=await saveLetterTemplate({companyId:company.id,template:selected,publish,expectedVersion:current?.version??0});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setDirty(false);setSelected(null);router.refresh();});};
 const version:TemplateVersion|undefined=selected?{version:(current?.version??0)+1,state:'draft',at:'',by:'',blocks:selected.blocks,fields:selected.fields}:undefined;
 return <main><DraftGuard dirty={dirty}/><header className="v9-heading"><div><h1>{t('templates.title')}</h1><p>{company.name}</p></div><Link className="v9-button" href="/lifecycle/probation">{t('backTracker')}</Link></header><PreparationNav companyId={company.id}/>
  <form method="get" className="probation-actions"><label className="v9-field"><span>{t('facts.company')}</span><select name="company" defaultValue={company.id}>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button className="v9-button" type="submit">{t('switchCompany')}</button></form>
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}<p className="v9-notice">{t('templates.heldDraft')}</p>
  <section className="v9-panel v9-stack"><h2>{t('templates.outcome')}</h2><div className="probation-actions">{(['confirm','extend','not_confirm'] as const).map(outcome=><button className="v9-button" type="button" key={outcome} disabled={busy||retirementDirty} aria-pressed={selected?.outcome===outcome} onClick={()=>choose(outcome)}>{t('templates.add',{outcome:t('outcomes.'+outcome)})}</button>)}</div>
   <ul className="v9-list">{latest.map(d=><li key={d.id}><button type="button" className="v9-button" disabled={busy||retirementDirty} onClick={()=>choose(d.data.outcome,d)}>{d.data.name}</button> · {t('version',{version:d.version})} · {t(d.state==='retired'?'retired':d.state==='published'?'published':'draft')}<details><summary>{t('templates.history',{count:definitions.filter(other=>other.key===d.key).length})}</summary><p className="v9-muted">{t('settings.versionHelp')}</p><ol className="v9-list">{definitions.filter(other=>other.key===d.key).map(saved=><li key={saved.id}><button type="button" className="v9-button" disabled={busy||retirementDirty} onClick={()=>choose(saved.data.outcome,saved)}>{t('version',{version:saved.version})}</button> · {t(saved.state==='retired'?'retired':saved.state==='published'?'published':'draft')}{saved.state==='retired'&&saved.retirementReason&&<p className="probation-note">{saved.retirementReason}</p>}</li>)}</ol></details></li>)}</ul>
  </section>
  {selected&&version&&<section className="v9-panel v9-stack"><h2>{t('templates.edit',{outcome:t('outcomes.'+selected.outcome)})}</h2><label className="v9-field"><span>{t('templates.name')}</span><input value={selected.name} maxLength={200} disabled={busy||retirementDirty} onChange={e=>update({name:e.target.value})}/></label>
   <fieldset className="probation-criterion" disabled={busy||retirementDirty}><legend>{t('templates.matching')}</legend><p className="v9-muted">{t('templates.matchingHelp')}</p><div className="v9-fields">{([{key:'businessGroup',label:'businessGroup',values:ruleOptions.businessGroups},{key:'businessUnit',label:'businessUnit',values:ruleOptions.businessUnits},{key:'department',label:'department',values:ruleOptions.departments},{key:'grade',label:'grade',values:ruleOptions.grades.map(code=>({id:code,name:code}))}] as const).map(scope=><label className="v9-field" key={scope.key}><span>{t('facts.'+scope.label)}</span><select multiple value={rule(scope.key)} onChange={e=>setRule(scope.key,Array.from(e.currentTarget.selectedOptions,option=>option.value))}>{scope.values.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}</select></label>)}<label className="v9-field"><span>{t('templates.extensionNumber')}</span><select multiple value={rule('extensionNumber')} onChange={e=>setRule('extensionNumber',Array.from(e.currentTarget.selectedOptions,option=>option.value))}>{['0','1','2'].map(number=><option key={number} value={number}>{number==='0'?t('templates.noExtension'):t('templates.extension',{number:Number(number)})}</option>)}</select></label></div></fieldset>
   <p className="v9-muted">{t('templates.mergeHelp')}</p><div className="probation-actions">{PROBATION_LETTER_KEYS.map(key=><code key={key}>{'{'+key+'}'}</code>)}</div>
   <TemplateVersionEditor labels={editorLabels} previewValues={{'company.name':company.name}} version={version} name={selected.name} disabled={busy||retirementDirty} fieldOwners={['hr','pmLocked']} defaultFieldOwner="hr" change={change=>{const next=structuredClone(version);change(next);next.fields=next.fields.map(field=>field.owner==='hr'?{...field,pmKey:null}:field);update({blocks:next.blocks,fields:next.fields});}}/>
   <h3>{t('templates.signing')}</h3><RouteFields value={selected.route} purpose="letter" disabled={busy||retirementDirty} change={route=>update({route})}/>
   <label className="v9-actions"><input type="checkbox" checked={!selected.unfinished} disabled={busy||retirementDirty} onChange={e=>update({unfinished:!e.target.checked})}/>{t('templates.reviewed')}</label>
   <div className="probation-savebar"><span role="status">{busy?t('saving'):dirty?t('unsaved'):t('draftSaved')}</span><div className="probation-actions"><button type="button" className="v9-button" disabled={busy||retirementDirty} onClick={()=>save(false)}>{t('saveDraft')}</button><button type="button" className="v9-button v9-button-primary" disabled={busy||retirementDirty||selected.unfinished} onClick={()=>save(true)}>{t('publishVersion')}</button></div></div>
  </section>}
  {publication?.state==='published'&&<RetireVersionControl key={publication.id+':'+current?.version} companyId={company.id} kind="template" versionId={publication.id} version={publication.version} blocked={busy||dirty} onDirtyChange={setRetirementDirty}/>}
 </main>;
}
