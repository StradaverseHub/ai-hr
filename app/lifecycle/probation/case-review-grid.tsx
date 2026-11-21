'use client';
import {useEffect,useRef} from 'react';
import {useTranslations} from 'next-intl';
import type {Assessment,ProbationKpi,ProbationPart} from '@/lib/probation-model';
import {scoreProbationForm,type ProbationCriterion,type ProbationForm} from '@/lib/probation-form';
import {probationDate} from '@/lib/probation-display';

/**
 * The Part 2 / Part 3 rating grid, result tiles and criterion guide (lane M2; prototype CriteriaGrid, RatingPills,
 * ScoreTiles, Drawer). Display and input only: the server scores the saved assessment and checks every submission.
 */
export type ProbationGuideTarget={kind:'kpi'}|{kind:'criterion';id:string};
export type ProbationGridMode='self'|'lm'|'view';
type Rating={rating:number|null;evidence:string};
const blank:Rating={rating:null,evidence:''};

function safeScore(form:ProbationForm,value:Assessment){try{return scoreProbationForm(form,value);}catch{return null;}}
const sectionWeight=(form:ProbationForm,section:ProbationCriterion['section'])=>form.criteria.filter(c=>c.section===section).reduce((n,c)=>n+c.weight,0);

export function RatingPills({value,labels,label,disabled=false,onChange}:{value:number|null;labels:string[];label:string;disabled?:boolean;onChange?:(rating:number)=>void}){
 const f=useTranslations('probation.caseView.form');
 return <div className="pcc-pills" role="group" aria-label={label}>{labels.map((name,index)=>{
  const rating=index+1,text=f('ratingButton',{rating,label:name});
  return <button key={rating} type="button" aria-pressed={value===rating} aria-label={text} title={text} disabled={disabled} onClick={()=>onChange?.(rating)}>{rating}</button>;
 })}</div>;
}

export function CriteriaGrid({form,employee,manager,mode,showEmployee,showManager,disabled=false,kpiEvidence=false,kpiCount,onRate,onEvidence,onGuide}:{
 form:ProbationForm;employee:Assessment;manager:Assessment;mode:ProbationGridMode;showEmployee:boolean;showManager:boolean;disabled?:boolean;kpiEvidence?:boolean;kpiCount:number;
 onRate?:(criterion:string,rating:number|null)=>void;onEvidence?:(criterion:string,evidence:string)=>void;onGuide:(target:ProbationGuideTarget)=>void;
}){
 const f=useTranslations('probation.caseView.form');
 const row=(c:ProbationCriterion)=>{
  const mine=mode==='self'?employee[c.id]??blank:mode==='lm'?manager[c.id]??blank:null,theirs=employee[c.id]??blank,lm=manager[c.id]??blank;
  const lowRating=!!mine&&mine.rating!==null&&mine.rating<=2,needsEvidence=lowRating||mode==='lm'&&kpiEvidence&&c.id==='kpi';
  const error=mine&&needsEvidence&&!mine.evidence.trim()?(lowRating?f('evidenceRequired',{rating:mine.rating!}):f('evidenceRequiredKpi')):null;
  const who=mode==='self'?f('col.employee'):f('col.lm');
  return <div role="row" className={'pcc-cr'+(error?' pcc-err':'')} key={c.id} data-criterion={c.id}>
   <div role="cell" className="pcc-cn">{c.title}{c.id==='kpi'
    ?<button type="button" className="pcc-link" onClick={()=>onGuide({kind:'kpi'})}>{f('kpiLink',{count:kpiCount})}<span aria-hidden="true"> ›</span></button>
    :<button type="button" className="pcc-link" aria-label={f('guideFor',{criterion:c.title})} onClick={()=>onGuide({kind:'criterion',id:c.id})}>{f('guide')}<span aria-hidden="true"> ›</span></button>}</div>
   <div role="cell" className="pcc-num"><span className="pcc-lbl">{f('col.weight')} </span>{c.weight}%</div>
   <div role="cell"><span className="pcc-lbl">{f('col.employee')}</span>
    {mode==='self'?<RatingCell value={theirs.rating} form={form} label={f('ratingGroup',{who,criterion:c.title})} criterion={c.title} disabled={disabled} onChange={rating=>onRate?.(c.id,rating)}/>
     :!showEmployee?<span className="pcc-small pcc-muted">{f('hiddenEmployee')}</span>
     :theirs.rating===null?<span className="pcc-muted">—</span>
     :<span className="pcc-small pcc-quote"><b>{theirs.rating}</b>{theirs.evidence.trim()?' · “'+theirs.evidence.trim()+'”':''}</span>}</div>
   <div role="cell"><span className="pcc-lbl">{f('col.lm')}</span>
    {mode==='lm'?<RatingCell value={lm.rating} form={form} label={f('ratingGroup',{who,criterion:c.title})} criterion={c.title} disabled={disabled} onChange={rating=>onRate?.(c.id,rating)}/>
     :showManager?<RatingPills value={lm.rating} labels={form.ratingLabels} label={f('ratingGroup',{who:f('col.lm'),criterion:c.title})} disabled/>
     :<span className="pcc-small pcc-muted">{f('hiddenLm')}</span>}</div>
   <div role="cell"><span className="pcc-lbl">{mode==='self'?f('col.yourEvidence'):f('col.evidence')}</span>
    {mine?<textarea aria-label={mode==='self'?f('yourEvidenceFor',{criterion:c.title}):f('evidenceFor',{criterion:c.title})} placeholder={f('evidencePlaceholder')} value={mine.evidence} maxLength={10000} required={needsEvidence} aria-invalid={error?true:undefined} disabled={disabled} onChange={e=>onEvidence?.(c.id,e.target.value)}/>
     :<div className="pcc-small pcc-quote">{showManager&&lm.evidence.trim()?lm.evidence:<span className="pcc-muted">—</span>}</div>}
    {error&&<div className="pcc-errt">{error}</div>}</div>
  </div>;
 };
 const principles=form.criteria.filter(c=>c.section==='principles');
 return <div className="pcc-crit" role="table" aria-label={f('gridLabel')}>
  <div role="row" className="pcc-cr pcc-cr-hd"><div role="columnheader">{f('col.criterion')}</div><div role="columnheader">{f('col.weight')}</div><div role="columnheader">{f('col.employee')}</div><div role="columnheader">{f('col.lm')}</div><div role="columnheader">{mode==='self'?f('col.yourEvidence'):f('col.evidence')}</div></div>
  <div role="row" className="pcc-cr pcc-cr-sec"><div role="cell" aria-colspan={5}>{f('sectionRole',{weight:sectionWeight(form,'role')})}</div></div>
  {form.criteria.filter(c=>c.section==='role').map(row)}
  <div role="row" className="pcc-cr pcc-cr-sec"><div role="cell" aria-colspan={5}>{f('sectionPrinciples',{count:principles.length,weight:sectionWeight(form,'principles')})}</div></div>
  {principles.map(row)}
 </div>;
}

function RatingCell({value,form,label,criterion,disabled,onChange}:{value:number|null;form:ProbationForm;label:string;criterion:string;disabled:boolean;onChange:(rating:number|null)=>void}){
 const f=useTranslations('probation.caseView.form');
 return <div className="pcc-row" style={{gap:6}}><RatingPills value={value} labels={form.ratingLabels} label={label} disabled={disabled} onChange={onChange}/>
  {value!==null&&!disabled&&<button type="button" className="pcc-link" style={{marginInlineStart:0}} aria-label={f('clearRatingFor',{criterion})} onClick={()=>onChange(null)}>{f('clearRating')}</button>}</div>;
}

/** Section A, Section B, Total and Band from the Line Manager's ratings, and the employee's self-score beside them. */
export function ScoreTiles({form,manager,employee,showEmployee,lowBand}:{form:ProbationForm;manager:Assessment;employee:Assessment;showEmployee:boolean;lowBand:number}){
 const f=useTranslations('probation.caseView.form');
 const rated=(section:ProbationCriterion['section'])=>form.criteria.filter(c=>c.section===section).reduce((n,c)=>{const r=manager[c.id]?.rating;return n+(typeof r==='number'?r*c.weight:0);},0);
 const max=(section:ProbationCriterion['section'])=>(sectionWeight(form,section)*5/100).toFixed(2);
 const score=safeScore(form,manager),self=showEmployee?safeScore(form,employee):null,band=score?form.bands.find(b=>b.band===score.band):null;
 return <div className="pcc-stack" style={{gap:8}}>
  <div className="pcc-score" aria-live="polite">
   <div className="pcc-sc"><span>{f('sectionA',{max:max('role')})}</span><b>{(rated('role')/100).toFixed(2)}</b></div>
   <div className="pcc-sc"><span>{f('sectionB',{max:max('principles')})}</span><b>{(rated('principles')/100).toFixed(2)}</b></div>
   <div className="pcc-sc"><span>{f('total',{max:(form.criteria.reduce((n,c)=>n+c.weight,0)*5/100).toFixed(2)})}</span><b>{score?(score.hundredths/100).toFixed(2):'—'}</b></div>
   <div className={'pcc-sc pcc-band'+(score&&score.band<=lowBand?' pcc-band-low':'')} data-testid="probation-band"><span>{f('band')}</span><b>{score?score.band+(band?' · '+band.label.replace(/ Expectations$/,''):''):f('rateAll',{count:form.criteria.length})}</b></div>
  </div>
  <p className="pcc-small pcc-muted">{self?f('selfScore',{score:(self.hundredths/100).toFixed(2),band:self.band}):f('selfScoreNone')}</p>
 </div>;
}

/** The criterion guide or the acknowledged Week 1 KPIs, in a side drawer (prototype Drawer); Escape closes it. */
export function GuideDrawer({target,form,kpis,support,onClose}:{target:ProbationGuideTarget;form:ProbationForm;kpis:ProbationKpi[];support?:ProbationPart['support']|null;onClose:()=>void}){
 const f=useTranslations('probation.caseView.form'),s=useTranslations('probation.caseView.form.supportLabels'),close=useRef<HTMLButtonElement>(null),closeRef=useRef(onClose);
 closeRef.current=onClose;
 useEffect(()=>{const back=document.activeElement as HTMLElement|null;close.current?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape')closeRef.current();};window.addEventListener('keydown',key);return()=>{window.removeEventListener('keydown',key);back?.focus?.();};},[]);
 const criterion=target.kind==='criterion'?form.criteria.find(c=>c.id===target.id)??null:null;
 const title=target.kind==='kpi'?f('drawer.kpiTitle'):f('drawer.criterionTitle',{criterion:criterion?.title??''});
 return <div>
  <div className="pcc-scrim" aria-hidden="true" onClick={onClose}/>
  <aside className="pcc-drawer" role="dialog" aria-modal="true" aria-label={title}>
   <button ref={close} className="pcc-x" type="button" aria-label={f('drawer.close')} onClick={onClose}>×</button>
   <h3>{title}</h3>
   {target.kind==='kpi'?<>
    <ol>{kpis.length?kpis.map(k=><li key={k.id}><b>{k.accountability}</b><br/><span className="pcc-small pcc-muted">{f('drawer.kpiLine',{measure:k.measure,target:k.target,date:probationDate(k.targetDate)})}</span></li>):<li className="pcc-muted">{f('drawer.noKpis')}</li>}</ol>
    {support&&<div className="pcc-stack" style={{gap:6}}><h4>{f('drawer.support')}</h4><dl className="probation-facts">{(['coaching','access','checkins','other'] as const).map(key=><div key={key}><dt>{s(key)}</dt><dd>{support[key]||'—'}</dd></div>)}</dl></div>}
   </>:criterion&&<div className="pcc-stack">
    <p><i>{criterion.standard}</i></p>
    {criterion.behaviours.length>0&&<div><h4>{f('drawer.behaviours')}</h4><ol>{criterion.behaviours.map(b=><li key={b}>{b}</li>)}</ol></div>}
    <div className="pcc-pbox"><b>{f('drawer.prompt')}</b><br/>{criterion.prompt}</div>
   </div>}
   <div className="pcc-pbox pcc-small"><b>{f('drawer.principles')}</b> {f('drawer.principlesText')}</div>
  </aside>
 </div>;
}
