import en from '../../../messages/en.json';import ms from '../../../messages/ms.json';import zh from '../../../messages/zh.json';import vi from '../../../messages/vi.json';import ta from '../../../messages/ta.json';import th from '../../../messages/th.json';
import {withAiAdmissionCheck,preparePrivateAiTask} from '../../../core/ai-governance';
import type {GenerateArgs} from '../../../lib/ai/types';
import {bindAiSpendTaskTx} from '../../../core/ai-spend-task';
import {draftInputDigest} from '../../../lib/ai/draft-input';
import {assertPerformanceProviderSourceTx} from './provider-source-authority';
import {createHash} from 'node:crypto';
import {and,asc,desc,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../../db/client';
import {onehrCycle,onehrReview,reviewCycle} from '../../../db/schema';
import {withPerformanceTenant} from '../../../core/module-gate';
import {searchKnowledgeArticlesTx} from '../../../core/knowledge-base';
import {generateDraft,type ResolvedAiConfig} from '../../../lib/ai';
import {toCsv} from '../../../lib/csv';
import {assessmentAiConfigTx,assessmentAiFeatureEnabledTx} from './ai-settings';
import {performanceWorkspaceTx,type PerformanceWorkspaceItem} from './service';
import {getAssessmentPersonalRecordTx} from './personal-record-service';
import {policySchema} from './model';
import {performanceGuideContext,performanceGuideMatches,performanceQuestionRefusal,resolvePerformanceGuideSelection,type PerformanceGuideFact} from './guide-model';

const stageNames:Record<string,string>={setting:'KPI setting',results:'KPI results',moderation:'KPI moderation',competency:'Technical competency',feedback:'360 feedback',career:'Development plan',plan:'Development plan',department_review:'Department performance review',department_potential_review:'Department potential review',calibration:'Performance calibration',potential_calibration:'Potential calibration',talent_box:'Talent Box',group_calibration:'Group calibration'};
const stateNames={open:'waiting on you',waiting:'waiting on someone else',done:'complete',later:'not open yet'};
function itemLink(item:PerformanceWorkspaceItem){return `/performance/workspace?${new URLSearchParams({cycle:item.cycleId,view:item.view,module:item.module,stage:item.stage,[item.kind]:item.id})}`;}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function configTx(tx:Tx,ctx:SessionContext){try{return await assessmentAiConfigTx(tx,ctx,'review');}catch{return null;}}
/** Same authorized worklist and own-record projector as the screens. No reviewer comments or scores from colleagues. */
export async function getPerformanceGuideFacts(ctx:SessionContext,question:string):Promise<PerformanceGuideFact[]>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};return withPerformanceTenant(ctx,tx=>getPerformanceGuideFactsTx(tx,ctx,question));
}
export async function getPerformanceGuideFactsTx(tx:Tx,ctx:SessionContext,question:string):Promise<PerformanceGuideFact[]>{
 await assertPerformanceProviderSourceTx(tx,ctx);const items=await performanceWorkspaceTx(tx,ctx),facts:PerformanceGuideFact[]=[];
 facts.push({id:'dashboard',label:'Your Performance workspace',text:items.length?`You have ${items.filter(i=>i.state==='open').length} current tasks waiting on you. Your remaining Performance tasks and dates are listed in your workspace.`:'You have no current Performance tasks. Your previous reviews remain in your record.',href:'/performance/workspace',source:'Your dashboard'});
 for(const key of [...new Set(items.map(i=>`${i.cycleId}:${i.view}:${i.stage}`))]){const group=items.filter(i=>`${i.cycleId}:${i.view}:${i.stage}`===key),first=group[0];facts.push({id:`summary:${key}`,label:`${first.cycle}: ${stageNames[first.stage]??first.stage} progress`,text:`${first.cycle} · ${stageNames[first.stage]??first.stage}: ${group.filter(i=>i.state==='open').length} waiting on you, ${group.filter(i=>i.state==='waiting').length} waiting on someone else, ${group.filter(i=>i.state==='done').length} complete, ${group.filter(i=>i.state==='later').length} not open yet.`,href:itemLink(first),source:'Your dashboard'});}
 for(const item of items)facts.push({id:`task:${item.key}`,label:`${stageNames[item.stage]??item.stage}: ${item.view==='mine'&&item.kind==='review'?'your review':item.title}`,text:`${item.cycle} · ${stageNames[item.stage]??item.stage}: ${item.view==='mine'&&item.kind==='review'?'your review':item.title} is ${stateNames[item.state]}.`,href:itemLink(item),source:'Your dashboard'});
 const records=await(async()=>{
  const rows=await tx.select({id:onehrReview.reviewId,employmentId:onehrReview.employmentId}).from(onehrReview).innerJoin(reviewCycle,eq(reviewCycle.id,onehrReview.cycleId)).where(and(sql`${reviewCycle.status}<>'draft'`,sql`exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`)).orderBy(desc(reviewCycle.periodEnd),asc(onehrReview.reviewId));
  const anchors=rows.filter((r,i)=>rows.findIndex(v=>v.employmentId===r.employmentId)===i),result=[];
  for(const anchor of anchors)result.push({anchor:anchor.id,record:await getAssessmentPersonalRecordTx(tx,ctx,anchor.id)});
  const cycleIds=[...new Set(items.map(i=>i.cycleId))];
  // Calendar facts are limited to assigned work cells, including a person's 360 assignments.
  for(const cycleId of cycleIds){const [row]=await tx.select({policy:onehrCycle.policy}).from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId));if(!row)continue;const policy=policySchema.parse(row.policy);
   for(const item of items.filter(i=>i.cycleId===cycleId)){const cell=item.kind==='feedback'?'f360':item.cell;if(!cell)continue;const window=policy.windows[cell];if(!window)continue;
    const format=(date:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(date));
    facts.push({id:`calendar:${item.key}`,label:`${stageNames[item.stage]??item.stage} dates`,text:`${item.cycle} · ${stageNames[item.stage]??item.stage}${window.opensAt?`: opens ${format(window.opensAt)}`:''}${window.closesAt?`; closes ${format(window.closesAt)}`:''} (Malaysia time).`,href:itemLink(item),source:'Your dashboard'});
   }
  }
  return result;
 })();
 for(const {anchor,record} of records){const href=`/me/performance?recordFor=${anchor}`;
  facts.push({id:`record:${anchor}`,label:'Your full Performance record',text:'Your record contains your current review, released results, 360 reports and development plan history.',href,source:'Your record'});
  if(record.current){const current=record.current;
   facts.push({id:`current:${anchor}`,label:'Your current result',text:`${current.name}: ${current.performance?`your approved performance band is ${current.performance}.`:'Your performance result is not available yet.'} ${current.report?'Your combined 360 report is available.':'Your 360 report appears once HR releases it.'}`,href,source:'Your record'});
  }
  for(const row of record.history.filter(row=>!row.current).slice(0,6))facts.push({id:`history:${row.id}`,label:`Your result: ${row.name}`,text:`${row.name}: ${row.performance?`released performance band ${row.performance}`:'no performance band released'}; ${row.potential?`released potential band ${row.potential}`:'no potential band released'}; ${row.talent?`talent status ${row.talent}`:'no talent status released'}. ${row.report?'Your combined 360 report is available.':'Your 360 report is not released.'}`,href:`${href}&record=${row.id}`,source:'Your record'});
 }
 const articles=await searchKnowledgeArticlesTx(tx,ctx,question,'performance-faq','dashboard');
 for(const article of articles)facts.push({id:`guide:${article.id}`,label:article.title,text:article.body.slice(0,700),href:`/knowledge-base/${article.id}`,source:'Performance guide'});
 return facts;
}
/** Finite own-task grammar only. Keyword hits do not prove a question's subject, polarity or scope.
 * Source-owned shortcuts remain usable in all six locales; human wording stays local. */
export type PrivatePerformanceGuideIntent='status'|'calendar'|'record'|'current'|'history'|'guide';
const guideNormalize=(value:string)=>value.normalize('NFC').trim().toLocaleLowerCase('en').replace(/[.!?。！？]+$/u,'').replace(/\s+/g,' ');
const privateGuideAliases:Readonly<Record<PrivatePerformanceGuideIntent,readonly string[]>>={
 status:['my review','my review status','my current tasks','what are my current tasks','what is my review status','what is left for me to do'],
 calendar:['my review dates','when does my part close','when is my review due','what are my review deadlines'],
 current:['my current result','what is my current result'],history:['my previous review','my past performance result','what was my result last cycle','show my previous review'],
 record:['my performance record','show my performance record'],guide:['what happens after i submit','how do i submit my review','where is my performance workspace'],
};
export function resolvePrivatePerformanceGuideIntent(question:string):PrivatePerformanceGuideIntent|null{
 const text=guideNormalize(question);
 for(const dictionary of [en,ms,zh,vi,ta,th]){const shortcuts=dictionary.onehr.ask;for(const [key,intent]of [['todo','status'],['dates','calendar'],['result','history'],['after','guide']]as const)if(text===guideNormalize(shortcuts[key]))return intent;}
 for(const [intent,phrases]of Object.entries(privateGuideAliases))if(phrases.some(phrase=>guideNormalize(phrase)===text))return intent as PrivatePerformanceGuideIntent;
 return null;
}
export function privatePerformanceGuideContext(question:string,facts:PerformanceGuideFact[],intent:PrivatePerformanceGuideIntent):PerformanceGuideFact[]{
 const eligible=(fact:PerformanceGuideFact)=>{const kind=fact.id.split(':')[0];switch(intent){
  case 'status':return fact.id==='dashboard'||kind==='summary'||kind==='task';
  case 'calendar':return kind==='calendar';case 'current':return kind==='current';case 'history':return kind==='history';
  case 'record':return ['record','current','history'].includes(kind);case 'guide':return kind==='guide';
 }};
 return performanceGuideContext(question,facts.filter(eligible));
}
const historySchema=z.array(z.object({role:z.enum(['user','agent']),content:z.string().max(600)})).max(10);
export type PerformanceGuideReply={text:string;facts:PerformanceGuideFact[];mode:'answer'|'search'|'declined'|'slowed';unanswered:boolean};
export async function askPerformanceGuide(ctx:SessionContext,rawQuestion:string,rawHistory:unknown=[]):Promise<PerformanceGuideReply>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 const question=z.string().trim().min(1).max(600).parse(rawQuestion),history=historySchema.parse(rawHistory);
 if(!ctx.userId)throw Error('Sign in to ask about your Performance record.');
 const requestId=await withPerformanceTenant(ctx,async tx=>{const [row]=await tx.execute<{id:string|null}>(sql`select app.assessment_guide_reserve() as id`);return row?.id;});
 if(!requestId)return {text:'You have asked six questions in a minute. Give it a moment, then ask again.',facts:[],mode:'slowed',unanswered:false};
 // Outcome counters retain no human question text, including unanswered local requests.
 const finish=(status:'answered'|'unanswered'|'declined'|'search')=>withPerformanceTenant(ctx,tx=>tx.execute(sql`select app.assessment_guide_finish(${requestId}::uuid,${status},${null})`));
 const refusal=performanceQuestionRefusal(question);
 if(refusal){await finish('declined');return {text:refusal.text,facts:[],mode:'declined',unanswered:false};}
 const intent=resolvePrivatePerformanceGuideIntent(question);
 if(intent===null){
  // Preserve the fresh native calling-principal authority before a local non-answer. Unknown wording
  // nominates no record source and cannot silently become an answer about the current employee.
  await withPerformanceTenant(ctx,tx=>assertPerformanceProviderSourceTx(tx,ctx));await finish('unanswered');
  return {text:'I can help with your own tasks, dates and released results. Choose a suggested question or ask about your own Performance record.',facts:[],mode:'search',unanswered:true};
 }
 const facts=await getPerformanceGuideFacts(ctx,question),cfg=await withPerformanceTenant(ctx,tx=>configTx(tx,ctx));
 const fingerprint=(f:PerformanceGuideFact[],c:ResolvedAiConfig|null)=>digest({facts:f,config:c?{provider:c.provider,model:c.model}:null});
 const before=fingerprint(facts,cfg);let selected:ReturnType<typeof resolvePerformanceGuideSelection>=null;
 if(cfg){try{
  let expected:string|undefined;const bound=withAiAdmissionCheck(cfg,'performance_review',async(tx,request)=>{
   if(request.operation!=='draft'||request.inputDigest!==expected||!await assessmentAiFeatureEnabledTx(tx,ctx,'review')||fingerprint(await getPerformanceGuideFactsTx(tx,ctx,question),cfg)!==before)throw Error('Current Performance guide source could not be confirmed.');
  });
  const rooted=await withPerformanceTenant(ctx,async tx=>{if(digest(await getPerformanceGuideFactsTx(tx,ctx,question))!==digest(facts))throw Error('Current Performance guide source could not be confirmed.');return bindAiSpendTaskTx(tx,ctx,bound,{kind:'performance_guide_request',sourceId:requestId});});
  const context=privatePerformanceGuideContext(question,facts,intent),providerIntent=intent==='current'||intent==='history'?'record':intent;
  const task=await preparePrivateAiTask(rooted,'performance_fact_selection_v1',async tx=>{if(fingerprint(await getPerformanceGuideFactsTx(tx,ctx,question),cfg)!==before)throw Error('Current Performance guide source could not be confirmed.');return {intent:providerIntent,facts:context.map((fact,index)=>({index,kind:['task','summary','calendar','record','current','history','guide'].includes(fact.id.split(':')[0])?fact.id.split(':')[0]:'other'})),source:before};});
  try{if(task.operation!=='draft')throw Error('Protected Performance guide operation unavailable.');expected=draftInputDigest(task.args as GenerateArgs);const choice:unknown=JSON.parse(await generateDraft(task.configuration,task.args as GenerateArgs));
   if(!choice||typeof choice!=='object'||Array.isArray(choice)||Object.keys(choice).sort().join(',')!=='items,unanswered'||!Array.isArray((choice as {items:unknown}).items)||typeof(choice as {unanswered:unknown}).unanswered!=='boolean')throw Error('Protected Performance guide selection unavailable.');
   const indices=(choice as {items:unknown[]}).items;if(indices.length>4||new Set(indices).size!==indices.length||indices.some(i=>typeof i!=='number'||!Number.isSafeInteger(i)||i<0||i>=context.length))throw Error('Protected Performance guide selection unavailable.');
   selected=resolvePerformanceGuideSelection({facts:indices.map(i=>context[i as number].id),unanswered:(choice as {unanswered:boolean}).unanswered},facts);
  }finally{task.dispose();}
 }catch{/* Search remains usable when the provider is unavailable or its selection fails adjudication. */}}
 // Re-fetch the actual owners after provider latency. Changed authorization/configuration cannot reuse old facts.
 const fresh=await getPerformanceGuideFacts(ctx,question),freshCfg=await withPerformanceTenant(ctx,tx=>configTx(tx,ctx));
 if(fingerprint(fresh,freshCfg)!==before)selected=null;
 if(!selected){await finish('search');return {text:'Here is what matches in your workspace, record and Performance guide.',facts:privatePerformanceGuideContext(question,fresh,intent).slice(0,4),mode:'search',unanswered:false};}
 await finish(selected.unanswered?'unanswered':'answered');
 return {text:selected.unanswered?'I can’t tell from your record or the guide. HR can help with this question.':selected.facts.map(f=>f.text).join('\n\n'),facts:selected.facts,mode:'answer',unanswered:selected.unanswered};
}
export const performanceGuideFilters=z.object({companyId:z.uuid().optional(),businessGroup:z.string().trim().max(300).optional(),department:z.string().trim().max(300).optional()});
export type PerformanceGuideReport={rows:{at:string;question:string;company:string;businessGroup:string;department:string}[];week:{answered:number;unanswered:number;declined:number;people:number}};
export async function getPerformanceGuideReport(ctx:SessionContext,raw:unknown={}){
 const f=performanceGuideFilters.parse(raw);
 return withPerformanceTenant(ctx,async tx=>{const [row]=await tx.execute<{value:PerformanceGuideReport}>(sql`select app.assessment_guide_report(${f.companyId??null}::uuid,${f.businessGroup||null},${f.department||null}) as value`);return row.value;});
}
export async function exportPerformanceGuideReport(ctx:SessionContext,raw:unknown={}){
 const report=await getPerformanceGuideReport(ctx,raw);
 return toCsv([['When (Malaysia time)','Question','Business group','Company','Department'],...report.rows.map(r=>[new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(new Date(r.at)),r.question,r.businessGroup,r.company,r.department])]);
}
