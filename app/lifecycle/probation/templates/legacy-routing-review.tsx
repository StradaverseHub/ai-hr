'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import type {Block} from '@/lib/lifecycle-v9-model';
import type {ProbationTemplate} from '@/lib/probation-workflow';
import type {DocumentRouting,DocumentRoutingWho} from '@/lib/document-signing-routing';
import {whoFromKey,whoKey,type RoutingChoices} from './routing-editor';
/** Explicit review preserves roles; no route/group name is used to infer a replacement. */
export function LegacyLetterRoutingReview({template,choices,disabled,onApply}:{template:ProbationTemplate&{routing?:DocumentRouting};choices:RoutingChoices;disabled:boolean;onApply:(routing:DocumentRouting,blocks:Block[])=>void}){
 const t=useTranslations('probationLetters'),roles=useTranslations('probation.roles');
 const original=template.routing?.length?template.routing.map(step=>({id:step.id,order:step.order,action:step.action,required:step.required!==false,owner:step.owner,who:step.who,role:step.who.kind})):
 template.route.steps.map(step=>({id:step.id,order:step.stage+1,action:step.kind,required:step.required,owner:false,who:step.role==='employee'?{kind:'employee' as const}:step.role==='lm'?{kind:'directSuperior' as const}:null,role:step.role}));
 const [selected,setSelected]=useState<Record<string,string>>(()=>Object.fromEntries(original.map(step=>[step.id,step.who&&(step.who.kind==='employee'||step.who.kind==='directSuperior')?whoKey(step.who):''])));
 const options=[{key:'employee',name:t('routing.whoEmployee')},{key:'directSuperior',name:t('routing.whoDirectSuperior')},...choices.routings.map(row=>({key:'routing:'+row.id,name:t('routing.whoRouting',{name:row.name})})),...choices.groups.map(row=>({key:'group:'+row.id,name:t('routing.whoGroup',{name:row.name})}))];
 const ready=original.length>0&&original.every(step=>options.some(option=>option.key===selected[step.id]));
 const apply=()=>{
  if(!ready)return;
  const routing:DocumentRouting=original.map(step=>({id:step.id,order:step.order,action:step.action,required:step.required,owner:step.owner,who:whoFromKey(selected[step.id],{kind:'employee'}) as DocumentRoutingWho}));
  const signers=routing.filter(step=>step.action==='sign'||step.action==='acknowledge'),nonEmployee=signers.filter(step=>step.who.kind!=='employee'),employee=signers.filter(step=>step.who.kind==='employee');
  // Existing step:<id> links retain identity. A legacy role block converts only with one exact role owner.
  const blocks=template.blocks.map(block=>{
   if(block.type!=='signature'||block.role?.startsWith('step:'))return structuredClone(block);
   const exact=original.filter(step=>step.role===block.role),target=exact.length===1?exact[0].id:block.role==='hr'&&nonEmployee.length===1?nonEmployee[0].id:block.role==='employee'&&employee.length===1?employee[0].id:null;
   return{...block,...(target?{role:'step:'+target}:{})};
  });
  onApply(routing,blocks);
 };
 return <section className="v9-panel v9-stack" aria-label={t('builder.migrationTitle')}>
  <h3>{t('builder.migrationTitle')}</h3><p className="v9-muted">{t('builder.migrationHelp')}</p>
  {original.map(step=><label key={step.id} className="v9-field"><span>{['pbp','hod','lm','employee'].includes(step.role)?roles(step.role):step.who?.kind==='routing'?t('routing.whoRouting',{name:step.who.routingId}):step.role} · {t('builder.currentSource')}</span><select disabled={disabled} value={selected[step.id]??''} onChange={event=>setSelected(previous=>({...previous,[step.id]:event.target.value}))}><option value="">{t('builder.chooseSource')}</option>{options.map(option=><option key={option.key} value={option.key}>{option.name}</option>)}</select></label>)}
  <button type="button" className="v9-button" disabled={disabled||!ready} onClick={apply}>{t('builder.applyMapping')}</button>
 </section>;
}
