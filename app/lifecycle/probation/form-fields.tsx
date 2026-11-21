'use client';
import {Fragment,useState} from 'react';
import {useTranslations} from 'next-intl';
import type {ProbationForm} from '@/lib/probation-form';
import {ApprovalRoutingFields,type ApproverChoices} from './approval-routing-fields';
import {GradeSelect} from './forms/grade-select';

type Criterion=ProbationForm['criteria'][number];
const SECTIONS=[{key:'role',letter:'A'},{key:'principles',letter:'B'}] as const;
/** Each section carries half of the score (the form's weight rule). */
const SECTION_WEIGHT=50;

/**
 * Prototype FormEditor body (lane M3): form name, job grade assignment (GradeSelect), review and approval routing per
 * part, then criteria and weights as one table per section with guidance opened in place, and the rating scale and
 * bands side by side. The value, its validation and the save path are unchanged.
 */
export function FormFields({value,change,disabled,users=[],approverChoices,grades=[]}:{value:ProbationForm;change:(value:ProbationForm)=>void;disabled:boolean;users?:readonly {id:string;name:string}[];approverChoices?:ApproverChoices;grades?:readonly string[]}){
 const t=useTranslations('probation'),pc=useTranslations('probationConfig'),[open,setOpen]=useState<string|null>(null);
 const update=(index:number,patch:Partial<Criterion>)=>change({...value,criteria:value.criteria.map((criterion,i)=>i===index?{...criterion,...patch}:criterion)});
 const sum=(section:Criterion['section'])=>value.criteria.filter(criterion=>criterion.section===section).reduce((total,criterion)=>total+(Number(criterion.weight)||0),0);
 const move=(index:number,step:-1|1)=>{const section=value.criteria[index].section;let other=index+step;while(other>=0&&other<value.criteria.length&&value.criteria[other].section!==section)other+=step;if(other<0||other>=value.criteria.length)return;const next=[...value.criteria];[next[index],next[other]]=[next[other],next[index]];change({...value,criteria:next});};
 const add=(section:Criterion['section'])=>{const id='criterion_'+crypto.randomUUID().replace(/-/g,'').slice(0,12);const last=value.criteria.map(criterion=>criterion.section).lastIndexOf(section);const next=[...value.criteria];next.splice(last+1,0,{id,section,title:'',weight:1,standard:'',behaviours:[],prompt:''});change({...value,criteria:next});setOpen(id);};
 return <div className="v9-stack">
  <label className="v9-field"><span>{t('form.name')}</span><input value={value.name} maxLength={200} disabled={disabled} onChange={e=>change({...value,name:e.target.value})}/></label>
  <section className="v9-stack" aria-labelledby="probation-form-grades"><div><h3 id="probation-form-grades">{pc('form.gradesTitle')}</h3><p className="pcg-sub">{pc('form.gradesHelp')}</p></div>
   <GradeSelect label={pc('form.gradesTitle')} value={value.targetGrades??[]} options={grades} disabled={disabled} onChange={next=>change({...value,targetGrades:next})}/>
   <p className="pcg-hint">{pc('form.gradesNote')}</p>
  </section>
  <ApprovalRoutingFields value={value} change={change} disabled={disabled} users={users} choices={approverChoices}/>
  <section className="v9-stack" aria-labelledby="probation-form-criteria"><h3 id="probation-form-criteria">{pc('form.criteriaTitle')}</h3>
   <p className="pcg-hint">{t('form.weights')}</p>
   {SECTIONS.map(section=>{const total=sum(section.key);return <div key={section.key} className="v9-stack" data-section={section.key}>
    <div className="pcg-section-head"><strong>{pc('form.section',{letter:section.letter,name:t('assessment.'+section.key)})}</strong><span className={total===SECTION_WEIGHT?'pcg-total':'pcg-total pcg-total-bad'}>{pc('form.sectionTotal',{total,weight:SECTION_WEIGHT})}</span></div>
    <div className="pcg-table"><table className="pcg-criteria"><thead><tr><th>{pc('form.criterion')}</th><th>{pc('form.weight')}</th><th>{pc('form.guidance')}</th><th><span className="sr-only">{pc('form.order')}</span></th></tr></thead><tbody>
     {value.criteria.map((criterion,index)=>criterion.section!==section.key?null:<Fragment key={criterion.id}>
      <tr><td data-label={pc('form.criterion')}><input aria-label={t('form.criterion')} value={criterion.title} maxLength={200} disabled={disabled} placeholder={pc('form.criterionPlaceholder')} onChange={e=>update(index,{title:e.target.value})}/></td>
       <td data-label={pc('form.weight')}><input type="number" min={1} max={100} aria-label={pc('form.weightFor',{name:criterion.title||pc('form.newCriterion')})} value={criterion.weight} disabled={disabled} onChange={e=>update(index,{weight:Number(e.target.value)})}/></td>
       <td data-label={pc('form.guidance')}><button type="button" className="pcg-link" aria-expanded={open===criterion.id} aria-controls={'guidance-'+criterion.id} onClick={()=>setOpen(open===criterion.id?null:criterion.id)}>{open===criterion.id?pc('form.hideGuidance'):disabled?pc('form.viewGuidance'):pc('form.editGuidance')}</button></td>
       <td><div className="pcg-row" style={{flexWrap:'nowrap'}}>
        <button type="button" className="pcg-link" disabled={disabled} aria-label={pc('form.moveUp',{name:criterion.title||pc('form.newCriterion')})} onClick={()=>move(index,-1)}>{pc('form.up')}</button>
        <button type="button" className="pcg-link" disabled={disabled} aria-label={pc('form.moveDown',{name:criterion.title||pc('form.newCriterion')})} onClick={()=>move(index,1)}>{pc('form.down')}</button>
        <button type="button" className="pcg-link pcg-danger" disabled={disabled||value.criteria.length<=1} aria-label={pc('form.removeNamed',{name:criterion.title||pc('form.newCriterion')})} onClick={()=>change({...value,criteria:value.criteria.filter((_,i)=>i!==index)})}>{t('remove')}</button>
       </div></td></tr>
      {open===criterion.id&&<tr className="pcg-guidance" id={'guidance-'+criterion.id}><td colSpan={4}><div className="v9-stack">
       <label className="v9-field"><span>{t('form.section')}</span><select value={criterion.section} disabled={disabled} onChange={e=>update(index,{section:e.target.value as Criterion['section']})}><option value="role">{t('assessment.role')}</option><option value="principles">{t('assessment.principles')}</option></select></label>
       {(['standard','prompt'] as const).map(key=><label className="v9-field" key={key}><span>{t('form.'+key)}</span><textarea value={criterion[key]} maxLength={10000} disabled={disabled} onChange={e=>update(index,{[key]:e.target.value})}/></label>)}
       <label className="v9-field"><span>{t('form.behaviours')}</span><textarea value={criterion.behaviours.join('\n')} maxLength={10000} disabled={disabled} onChange={e=>update(index,{behaviours:e.target.value.split('\n')})}/></label>
      </div></td></tr>}
     </Fragment>)}
    </tbody></table></div>
    <div><button type="button" className="v9-button" disabled={disabled||value.criteria.length>=30} onClick={()=>add(section.key)}>{pc('form.addCriterion',{letter:section.letter})}</button></div>
   </div>;})}
   <p className="pcg-total"><strong>{pc('form.formTotal',{total:sum('role')+sum('principles')})}</strong> {pc('form.formTotalParts',{a:sum('role'),b:sum('principles')})}</p>
  </section>
  <div className="pcg-grid2">
   <section className="pcg-card" aria-labelledby="probation-form-scale"><h3 id="probation-form-scale">{pc('form.scaleTitle')}</h3>
    {value.ratingLabels.map((label,index)=><label className="v9-field" key={index}><span>{t('form.ratingNumber',{rating:index+1})}</span><input value={label} disabled={disabled} onChange={e=>change({...value,ratingLabels:value.ratingLabels.map((text,i)=>i===index?e.target.value:text)})}/></label>)}
   </section>
   <section className="pcg-card" aria-labelledby="probation-form-bands"><h3 id="probation-form-bands">{pc('form.bandsTitle')}</h3>
    {value.bands.map((band,index)=><div className="v9-fields" key={band.band}><label className="v9-field"><span>{t('form.bandLabel',{band:band.band})}</span><input value={band.label} disabled={disabled} onChange={e=>change({...value,bands:value.bands.map((b,i)=>i===index?{...b,label:e.target.value}:b)})}/></label><label className="v9-field"><span>{t('form.bandMinimum')}</span><input type="number" min={1} max={5} step="0.01" value={band.min/100} disabled={disabled} onChange={e=>change({...value,bands:value.bands.map((b,i)=>i===index?{...b,min:Math.round(Number(e.target.value)*100)}:b)})}/></label></div>)}
   </section>
  </div>
  <label className="v9-actions"><input type="checkbox" checked={value.employeeCommentsRequired} disabled={disabled} onChange={e=>change({...value,employeeCommentsRequired:e.target.checked})}/>{t('form.commentsRequired')}</label>
 </div>;
}
