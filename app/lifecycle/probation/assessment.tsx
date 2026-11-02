'use client';
import {useId} from 'react';
import {useTranslations} from 'next-intl';
import type {Assessment} from '@/lib/probation-model';
import {scoreProbationForm,type ProbationForm} from '@/lib/probation-form';
export function AssessmentFields({form,value,readOnly=false,onChange,owner,kpiEvidence=false}:{form:ProbationForm;value:Assessment;readOnly?:boolean;onChange?:(value:Assessment)=>void;owner:'employee'|'lm';kpiEvidence?:boolean}){
 const t=useTranslations('probation'),id=useId(),score=scoreProbationForm(form,value);
 return <div className="probation-assessment"><p className="v9-muted">{readOnly?t('assessment.readOnly'):t('assessment.instructions')}</p>
  {(['role','principles'] as const).map(section=><section className="v9-stack" key={section} aria-label={t('assessment.'+section)}><h2>{t('assessment.'+section)}</h2>{form.criteria.filter(c=>c.section===section).map(c=>{
   const rating=value[c.id]??{rating:null,evidence:''},evidenceRequired=rating.rating!==null&&rating.rating<=2||kpiEvidence&&c.id==='kpi';
   const update=(patch:Partial<typeof rating>)=>onChange?.({...value,[c.id]:{...rating,...patch}});
   return <fieldset className="probation-criterion" key={c.id} disabled={readOnly}><legend>{c.title} <span className="v9-muted">· {c.weight}%</span></legend>
    <details><summary>{t('assessment.guidance')}</summary><p>{c.standard}</p>{c.behaviours.length>0&&<ul>{c.behaviours.map(behaviour=><li key={behaviour}>{behaviour}</li>)}</ul>}<p>{c.prompt}</p></details>
    {readOnly?<p>{t('assessment.rating')}: <strong>{rating.rating===null?t('assessment.unrated'):rating.rating+' · '+form.ratingLabels[rating.rating-1]}</strong></p>:<div className="probation-ratings">{form.ratingLabels.map((label,index)=><label key={index}><input type="radio" name={id+'-'+c.id} value={index+1} checked={rating.rating===index+1} onChange={()=>update({rating:index+1})}/>{index+1} · {label}</label>)}<button type="button" className="v9-button" onClick={()=>update({rating:null})} disabled={rating.rating===null}>{t('assessment.clear')}</button></div>}
    <label className="v9-field probation-evidence" htmlFor={id+'-'+c.id+'-evidence'}><span>{t('assessment.evidence')}{evidenceRequired?' *':''}</span>{readOnly?<span className="probation-note">{rating.evidence||t('assessment.none')}</span>:<textarea id={id+'-'+c.id+'-evidence'} value={rating.evidence} maxLength={10000} required={evidenceRequired} onChange={e=>update({evidence:e.target.value})}/>}</label>
   </fieldset>;
  })}</section>)}
  <div className="probation-scores" aria-live="polite"><p>{t('assessment.roleScore')}<strong>{score?(score.sectionA/100).toFixed(2):'—'}</strong></p><p>{t('assessment.principlesScore')}<strong>{score?(score.sectionB/100).toFixed(2):'—'}</strong></p><p>{t('assessment.total')}<strong>{score?(score.hundredths/100).toFixed(2):'—'}</strong></p><p>{t('assessment.band')}<strong>{score?score.band:'—'}</strong></p></div>
  <p className="v9-muted">{owner==='employee'?t('assessment.selfScore'):t('assessment.managerScore')}</p>
 </div>;
}
