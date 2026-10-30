import {createHash} from 'node:crypto';
import type {SessionContext,Tx} from '../../../db/client';
import {withPerformanceTenant} from '../../../core/module-gate';
import {bindPerformanceMessageSpend,type PerformanceMessageSpendTask} from '../../../core/ai-spend-task';
import {withAiAdmissionCheck,preparePrivateAiTask} from '../../../core/ai-governance';
import {draftInputDigest} from '../../../lib/ai/draft-input';
import {generateDraft,type ResolvedAiConfig} from '../../../lib/ai';
import {recordProposal} from '../../../core/agent-proposal';
import {adjudicateReviewCommands,type ReviewCommandFacts} from './review-command-model';
import {adjudicateSettingCommands,type SettingCommandFacts} from './setting-command-model';
import {adjudicateEvidenceCommands,type EvidenceCommandFacts} from './evidence-command-model';
import {adjudicateCareerCommands,type CareerCommandFacts} from './career-command-model';
import {assessmentAiConfigTx,assessmentAiFeatureEnabledTx} from './ai-settings';
import {adjudicateSettingSuggestion} from './setting-suggestion-model';
import {settingNumbersComplete} from './setting-default-model';
import {literalCareerProposal,literalSettingProposal,literalReviewProposal,literalEvidenceProposal,type LiteralDraftCommand} from './literal-command-parser';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function indices(raw:string,maximum:number):number[]{const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).join(',')!=='items'||!Array.isArray((parsed as {items:unknown}).items))throw Error('Protected command selection unavailable.');const items=(parsed as {items:unknown[]}).items;if(new Set(items).size!==items.length||items.some(i=>typeof i!=='number'||!Number.isSafeInteger(i)||i<0||i>=maximum))throw Error('Protected command reference unavailable.');return items as number[];}
/** The native owner parses the explicit human request before provider work. Only command ordinals and
 * action enums leave; the exact literal proposal is restored locally and re-adjudicated by its owner. */
async function confirmLiteral(cfg:ResolvedAiConfig,channel:'career'|'setting'|'review'|'journey',facts:unknown,proposal:{commands:LiteralDraftCommand[]},replay:(tx:Tx)=>Promise<unknown>){
 const source=digest(facts);let expected:string|undefined;
 const current=async(tx:Tx)=>{if(digest(await replay(tx))!==source)throw Error('Current editable assessment source changed.');return{channel,commands:proposal.commands.map((command,index)=>({index,action:command.action})),source};};
 const bound=withAiAdmissionCheck(cfg,'performance_assistant',async(tx,request)=>{if(request.operation!=='draft'||request.inputDigest!==expected)throw Error('Protected command input changed.');await current(tx);});
 const task=await preparePrivateAiTask(bound,'performance_explicit_commands_v1',current);
 try{if(task.operation!=='draft')throw Error('Protected command operation unavailable.');expected=draftInputDigest(task.args);const raw=await generateDraft(task.configuration,task.args);try{const selected=indices(raw,proposal.commands.length);if(selected.length!==proposal.commands.length)throw Error('Explicit command selection was not confirmed.');return JSON.stringify(proposal);}catch{return JSON.stringify({unsupportedProtectedSelection:true});}}finally{task.dispose();}
}
export async function proposeSettingSuggestion(ctx:SessionContext,reviewId:string,facts:SettingCommandFacts,replay:(tx:Tx)=>Promise<SettingCommandFacts|null>){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};facts=structuredClone(facts);
 const cfg=await withPerformanceTenant(ctx,tx=>assessmentAiConfigTx(tx,ctx,'pm'));if(!cfg)return null;
 const eligible=facts.library.slice(0,100).filter(item=>settingNumbersComplete(item.defaultScoring??item.scoring));if(!eligible.length)return null;
 const source=digest(facts);let expected:string|undefined;
 const current=async(tx:Tx)=>{if(digest(await replay(tx))!==source)throw Error('Current editable assessment source changed.');return{items:eligible.map((_item,index)=>({index,scoringReady:true})),source};};
 const bound=withAiAdmissionCheck(cfg,'performance_pm',async(tx,request)=>{if(request.operation!=='draft'||request.inputDigest!==expected)throw Error('Protected scorecard input changed.');await current(tx);});
 const task=await preparePrivateAiTask(bound,'performance_starter_selection_v1',current);let raw:string;
 try{if(task.operation!=='draft')throw Error('Protected scorecard operation unavailable.');expected=draftInputDigest(task.args);const selectedRaw=await generateDraft(task.configuration,task.args);try{const selected=indices(selectedRaw,eligible.length);if(!selected.length||selected.length>8)throw Error('No eligible usable scorecard selection.');raw=JSON.stringify(selected.map(i=>{const weight=eligible[i].weightBp;return{id:eligible[i].id,weightage:typeof weight==='number'&&weight>0?weight:1};}));}catch{raw='[]';}}finally{task.dispose();}
 const checked=adjudicateSettingSuggestion(raw,facts.library,facts.moderatorEmploymentId);
 await recordProposal(ctx,{type:'performance_draft_command',subject:{type:'performance-review',id:reviewId},facts:{kind:'setting_suggestion',text:facts.text,library:facts.library},proposal:checked?{kpis:checked.kpis}:{},adjudication:checked?{ok:true}:{ok:false,reason:'No eligible usable scorecard selection.'},provider:cfg.provider,model:cfg.model});
 if(!(await withPerformanceTenant(ctx,tx=>assessmentAiFeatureEnabledTx(tx,ctx,'pm'))))return null;return checked;
}
export async function proposeCareerCommands(ctx:SessionContext,reviewId:string,facts:CareerCommandFacts,replay:(tx:Tx)=>Promise<CareerCommandFacts|null>,spendTask?:PerformanceMessageSpendTask){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};facts=structuredClone(facts);const proposal=literalCareerProposal(facts);if(!proposal)return null;
 const initial=adjudicateCareerCommands(JSON.stringify(proposal),facts);if(!initial.ok)return null;
 const available=await withPerformanceTenant(ctx,tx=>assessmentAiConfigTx(tx,ctx));if(!available)return null;const cfg=bindPerformanceMessageSpend(available,ctx,reviewId,spendTask);
 const raw=await confirmLiteral(cfg,'career',facts,proposal,replay),checked=adjudicateCareerCommands(raw,facts);
 await recordProposal(ctx,{type:'performance_draft_command',subject:{type:'performance-review',id:reviewId},facts:{text:facts.text,kind:'career',goals:facts.goals.map(g=>({id:g.id,label:g.area})),roles:facts.roles,canEditCareer:facts.canEditCareer,canEditGoals:facts.canEditGoals},proposal:checked.ok?checked.proposal:{},adjudication:checked.ok?{ok:true}:{ok:false,reason:checked.reason},provider:cfg.provider,model:cfg.model});return checked.ok&&(checked.careerChanged||checked.goalsChanged)?checked:null;
}
export async function proposeSettingCommands(ctx:SessionContext,reviewId:string,facts:SettingCommandFacts,replay:(tx:Tx)=>Promise<SettingCommandFacts|null>,spendTask?:PerformanceMessageSpendTask){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};facts=structuredClone(facts);const proposal=literalSettingProposal(facts);if(!proposal||!adjudicateSettingCommands(JSON.stringify(proposal),facts).ok)return null;
 const available=await withPerformanceTenant(ctx,tx=>assessmentAiConfigTx(tx,ctx));if(!available)return null;const cfg=bindPerformanceMessageSpend(available,ctx,reviewId,spendTask),raw=await confirmLiteral(cfg,'setting',facts,proposal,replay),checked=adjudicateSettingCommands(raw,facts);
 await recordProposal(ctx,{type:'performance_draft_command',subject:{type:'performance-review',id:reviewId},facts:{text:facts.text,kind:'setting',targets:facts.kpis.map(k=>({id:k.id,label:k.title})),library:facts.library.map(k=>({id:k.id,label:k.title}))},proposal:checked.ok?checked.proposal:{},adjudication:checked.ok?{ok:true}:{ok:false,reason:checked.reason},provider:cfg.provider,model:cfg.model});return checked.ok&&checked.changed?checked:null;
}
export async function proposeReviewCommands(ctx:SessionContext,reviewId:string,facts:ReviewCommandFacts,replay:(tx:Tx)=>Promise<ReviewCommandFacts|null>,spendTask?:PerformanceMessageSpendTask){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};facts=structuredClone(facts);const proposal=literalReviewProposal(facts);if(!proposal||!adjudicateReviewCommands(JSON.stringify(proposal),facts).ok)return null;
 const available=await withPerformanceTenant(ctx,tx=>assessmentAiConfigTx(tx,ctx));if(!available)return null;const cfg=bindPerformanceMessageSpend(available,ctx,reviewId,spendTask),raw=await confirmLiteral(cfg,'review',facts,proposal,replay),checked=adjudicateReviewCommands(raw,facts);
 await recordProposal(ctx,{type:'performance_draft_command',subject:{type:'performance-review',id:reviewId},facts:{text:facts.text,kind:facts.draft.kind,targets:facts.targets},proposal:checked.ok?checked.proposal:{},adjudication:checked.ok?{ok:true}:{ok:false,reason:checked.reason},provider:cfg.provider,model:cfg.model});return checked.ok&&(checked.changed||checked.reflection)?checked:null;
}
export async function proposeJourneyCommands(ctx:SessionContext,reviewId:string,review:ReviewCommandFacts|null,evidence:EvidenceCommandFacts|null,replay:(tx:Tx)=>Promise<{review:ReviewCommandFacts|null;evidence:EvidenceCommandFacts|null}>,spendTask?:PerformanceMessageSpendTask){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};review=structuredClone(review);evidence=structuredClone(evidence);
 const r=review?literalReviewProposal(review):null,e=evidence?literalEvidenceProposal(evidence):null;if(!r&&!e)return null;
 const rp=r??{commands:[]},ep=e??{commands:[]};if(review&&!adjudicateReviewCommands(JSON.stringify(rp),review).ok||evidence&&!adjudicateEvidenceCommands(JSON.stringify(ep),evidence).ok)return null;
 const available=await withPerformanceTenant(ctx,tx=>assessmentAiConfigTx(tx,ctx));if(!available)return null;const cfg=bindPerformanceMessageSpend(available,ctx,reviewId,spendTask),proposal={commands:[...rp.commands,...ep.commands]},raw=await confirmLiteral(cfg,'journey',{review,evidence},proposal,replay);
 let result:null|{review:ReturnType<typeof adjudicateReviewCommands>&{ok:true}|null;evidence:ReturnType<typeof adjudicateEvidenceCommands>&{ok:true}|null}=null,reason='Invalid journey command.';
 try{const parsed=JSON.parse(raw),evidenceActions=new Set(['log_evidence','checkin']),rc=review?adjudicateReviewCommands(JSON.stringify({commands:parsed.commands.filter((c:{action:string})=>!evidenceActions.has(c.action))}),review):null,ec=evidence?adjudicateEvidenceCommands(JSON.stringify({commands:parsed.commands.filter((c:{action:string})=>evidenceActions.has(c.action))}),evidence):null;
  if(rc&&!rc.ok)throw Error(rc.reason);if(ec&&!ec.ok)throw Error(ec.reason);result={review:rc?.ok&&(rc.changed||rc.reflection)?rc:null,evidence:ec?.ok&&ec.commands.length?ec:null};
 }catch(error){reason=error instanceof Error?error.message:reason;}
 await recordProposal(ctx,{type:'performance_draft_command',subject:{type:'performance-review',id:reviewId},facts:{review,evidence},proposal:result?JSON.parse(raw):{},adjudication:result?{ok:true}:{ok:false,reason},provider:cfg.provider,model:cfg.model});return result;
}
