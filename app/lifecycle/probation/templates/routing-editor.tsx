'use client';
import {useTranslations} from 'next-intl';
import type {Block} from '@/lib/lifecycle-v9-model';
import {
 DOCUMENT_ROUTING_ACTIONS,MAX_DOCUMENT_ROUTING_ORDER,SIGNATURE_STEP_PREFIX,documentRoutingProblems,documentRoutingSignatureProblems,
 documentRoutingSignSteps,signatureBlockStepId,sortedDocumentRouting,
 type DocumentRouting,type DocumentRoutingStep,type DocumentRoutingWho,
} from '@/lib/document-signing-routing';
import {PeopleSearch} from '@/app/automation/people-search';

export type RoutingChoice={id:string;name:string};
export type RoutingChoices={routings:readonly RoutingChoice[];groups:readonly RoutingChoice[];people:readonly RoutingChoice[]};

/** One select value per "who": employee, directSuperior, routing:<id>, group:<id>, people. */
export function whoKey(who:DocumentRoutingWho):string{return who.kind==='routing'?'routing:'+who.routingId:who.kind==='group'?'group:'+who.groupId:who.kind;}
export function whoFromKey(key:string,current:DocumentRoutingWho):DocumentRoutingWho|null{
 if(key==='employee'||key==='directSuperior')return{kind:key};
 if(key==='people')return current.kind==='people'?current:{kind:'people',userIds:[]};
 if(key.startsWith('routing:')&&key.length>8)return{kind:'routing',routingId:key.slice(8)};
 if(key.startsWith('group:')&&key.length>6)return{kind:'group',groupId:key.slice(6)};
 return null;
}
export function newRoutingStep(routing:DocumentRouting,id:string,who:DocumentRoutingWho):DocumentRoutingStep{
 return{id,order:Math.min(MAX_DOCUMENT_ROUTING_ORDER,routing.reduce((max,step)=>Math.max(max,step.order),0)+1),action:'sign',who,owner:false,pick:'any'};
}

/**
 * "Signing and review routing" on one template version (handoff A2; prototype TemplateEditor). Rows: Order, Action
 * (Review · Approve · Sign), Who, Owns the document; Add / Remove step; signature blocks linked to Sign steps. Problems
 * are the same pure checks the server applies. `editable` is false while the version is read-only.
 */
export function TemplateRoutingEditor({value,blocks,choices,editable,onChange,onBlocksChange,newId,requireSign=true,teamLabels}:{
 teamLabels?:{pick:string;hint:string};requireSign?:boolean;value:DocumentRouting;blocks:readonly Block[];choices:RoutingChoices;editable:boolean;
 onChange:(routing:DocumentRouting)=>void;onBlocksChange:(blocks:Block[])=>void;newId:()=>string;
}){
 const t=useTranslations('probationLetters');
 const known={routings:new Set(choices.routings.map(r=>r.id)),groups:new Set(choices.groups.map(g=>g.id)),people:new Set(choices.people.map(p=>p.id))};
 const problems=[...documentRoutingProblems(value,{routingExists:id=>known.routings.has(id),groupExists:id=>known.groups.has(id),personExists:id=>known.people.has(id)},{requireSign}),...documentRoutingSignatureProblems(value,blocks)];
 const name=(list:readonly RoutingChoice[],id:string)=>list.find(item=>item.id===id)?.name??t('routing.unknown');
 const whoLabel=(who:DocumentRoutingWho)=>who.kind==='employee'?t('routing.whoEmployee'):who.kind==='directSuperior'?t('routing.whoDirectSuperior'):who.kind==='routing'?t('routing.whoRouting',{name:name(choices.routings,who.routingId)}):who.kind==='group'?t('routing.whoGroup',{name:name(choices.groups,who.groupId)}):t('routing.whoPeople');
 const update=(id:string,patch:Partial<DocumentRoutingStep>)=>onChange(value.map(step=>step.id===id?{...step,...patch}:patch.owner?{...step,owner:false}:step));
 const signSteps=documentRoutingSignSteps(value),sorted=sortedDocumentRouting(value);
 const disabled=!editable;
 return <section className="v9-stack probation-routing" aria-labelledby="probation-routing-title">
  <h3 id="probation-routing-title">{t('routing.title')}</h3>
  <p className="v9-muted">{t('routing.help')}</p>
  {!value.length&&<p className="v9-muted">{t('routing.empty')}</p>}
  {sorted.map((step,i)=>{const n=i+1,whoOptions=[
   {key:'employee',label:t('routing.whoEmployee')},{key:'directSuperior',label:t('routing.whoDirectSuperior')},
   ...choices.routings.map(r=>({key:'routing:'+r.id,label:t('routing.whoRouting',{name:r.name})})),
   ...choices.groups.map(g=>({key:'group:'+g.id,label:t('routing.whoGroup',{name:g.name})})),
   {key:'people',label:t('routing.whoPeople')}];
   const current=whoKey(step.who);
   return <fieldset key={step.id} className="probation-criterion" disabled={disabled} aria-label={t('routing.stepTitle',{n})}>
    <legend>{t('routing.stepTitle',{n})}</legend>
    <div className="v9-fields">
     <label className="v9-field"><span>{t('routing.order')}</span><input type="number" min={1} max={MAX_DOCUMENT_ROUTING_ORDER} value={step.order} onChange={e=>update(step.id,{order:Math.max(1,Math.min(MAX_DOCUMENT_ROUTING_ORDER,Math.floor(Number(e.target.value)||1)))})}/></label>
     <label className="v9-field"><span>{t('routing.action')}</span><select value={step.action} onChange={e=>update(step.id,{action:e.target.value as DocumentRoutingStep['action']})}>{DOCUMENT_ROUTING_ACTIONS.map(action=><option key={action} value={action}>{t('routing.actions.'+action)}</option>)}</select></label>
     <label className="v9-field"><span>{t('routing.who')}</span><select value={current} onChange={e=>{const who=whoFromKey(e.target.value,step.who);if(who)update(step.id,{who});}}>
      {!whoOptions.some(o=>o.key===current)&&<option value={current}>{whoLabel(step.who)}</option>}
      {whoOptions.map(o=><option key={o.key} value={o.key}>{o.label}</option>)}</select></label>
     {(step.who.kind==='routing'||step.who.kind==='group'||step.who.kind==='people'&&step.who.userIds.length>1)&&<label className="v9-field"><span>{teamLabels?.pick??t('routing.pick')}</span><select value={step.pick??'any'} onChange={e=>update(step.id,{pick:e.target.value==='roundRobin'?'roundRobin':'any'})}><option value="any">{t('routing.pickAny')}</option><option value="roundRobin">{t('routing.pickRoundRobin')}</option></select></label>}
     <label className="v9-actions"><input type="checkbox" checked={step.owner} onChange={e=>update(step.id,{owner:e.target.checked})}/>{t('routing.owner')}</label>
    </div>
    {(step.who.kind==='routing'||step.who.kind==='group'||!!teamLabels&&step.who.kind==='people'&&step.who.userIds.length>1)&&<p className="v9-muted">{teamLabels?.hint??t('routing.oneOfGroup')}</p>}
    {step.who.kind==='people'&&<div className="v9-stack"><span>{t('routing.people')}</span>
     <ul className="v9-list">{step.who.userIds.map(id=><li key={id}>{name(choices.people,id)} <button type="button" className="v9-button" onClick={()=>step.who.kind==='people'&&update(step.id,{who:{kind:'people',userIds:step.who.userIds.filter(other=>other!==id)}})}>{t('routing.removePerson',{name:name(choices.people,id)})}</button></li>)}</ul>
     <PeopleSearch disabled={disabled} known={step.who.userIds.map(id=>({id,name:name(choices.people,id)}))} onAdd={person=>{if(step.who.kind==='people'&&!step.who.userIds.includes(person.id))update(step.id,{who:{kind:'people',userIds:[...step.who.userIds,person.id]}});}}/>
    </div>}
    <div className="probation-actions"><span className="v9-muted">{t('routing.hint.'+step.action)}{step.owner?' '+t('routing.hint.owner'):''}</span><button type="button" className="v9-button" onClick={()=>{onChange(value.filter(other=>other.id!==step.id));}}>{t('routing.remove',{n})}</button></div>
   </fieldset>;})}
  <div><button type="button" className="v9-button" disabled={disabled} onClick={()=>onChange([...value,newRoutingStep(value,newId(),{kind:'employee'})])}>{t('routing.add')}</button></div>
  {value.length>0&&<div className="v9-stack"><h4>{t('routing.blocks')}</h4><p className="v9-muted">{t('routing.blocksHelp')}</p>
   {blocks.filter(block=>block.type==='signature').length===0&&<p className="v9-muted">{t('routing.noBlocks')}</p>}
   {blocks.map((block,index)=>{if(block.type!=='signature')return null;const linked=signatureBlockStepId(block),stale=linked&&!signSteps.some(step=>step.id===linked);
    return <label className="v9-field" key={block.id}><span>{t('routing.blockLabel',{n:index+1})}</span><select disabled={disabled} value={block.role??''} onChange={e=>onBlocksChange(blocks.map(other=>other.id===block.id?{...other,role:e.target.value}:other))}>
     <option value="" disabled>{t('routing.chooseStep')}</option>
     {!linked&&block.role&&<option value={block.role}>{t('routing.oldSetting',{role:block.role})}</option>}
     {stale&&<option value={block.role}>{t('routing.stepRemoved')}</option>}
     {signSteps.map(step=><option key={step.id} value={SIGNATURE_STEP_PREFIX+step.id}>{t('routing.stepOption',{order:step.order,who:whoLabel(step.who)})}</option>)}
    </select></label>;})}
  </div>}
  {problems.length>0&&<div className="v9-notice v9-error" role="alert"><strong>{t('routing.problems')}</strong><ul>{problems.map(problem=><li key={problem}>{problem}</li>)}</ul></div>}
 </section>;
}
