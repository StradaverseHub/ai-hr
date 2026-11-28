'use server';

import {randomUUID,createHash} from 'node:crypto';
import {revalidatePath} from 'next/cache';
import {scopedAdmin} from '@/lib/scope';
import {
  saveOvertimePatternDraft, getOvertimePattern, overtimePatternWorkspaceCompanies,
  closeOvertimePatternAssignment, cancelOvertimePatternAssignment, overtimePatternSetup, overtimePositionChoices,
  previewOvertimePatternEligibility, activateOvertimePatternWithEligibility, forkOvertimePatternDraft, archiveOvertimePattern,
  OvertimeOwnerError, previewOvertimePatternEmployee, previewOvertimePatternSample, calculateOvertimePatternDay, readOvertimePatternCalculation,
  type OvertimePatternDraft,
} from '@/packs/attendance/service';
import {overtimeEditorBase,overtimeEditorDefinition,overtimeEditorCurrency} from '@/lib/overtime-pattern-editor-scope';
import {overtimeStarter} from '@/lib/overtime-pattern-starters';
import {definitionToOvertimeSettings,overtimeSettingsToDefinition,parseOvertimeSettings} from '@/lib/overtime-pattern-settings';
import {validateOvertimePatternDraft} from '@/lib/overtime-pattern-schema';
import {OvertimePatternError} from '@/lib/overtime-pattern-model';
import {OVERTIME_LIMITS,OVERTIME_SAMPLE_INPUT_FIELDS} from '@/lib/overtime-pattern-model';
import type {OvertimeIssue,OvertimeInput,OvertimeFact,OvertimeRawSegment} from '@/lib/overtime-pattern-model';
import type {OvertimeSampleDraft} from '@/lib/overtime-pattern-ui';
import {overtimePatternTransferOptions,transferOvertimePatternToPayroll,OvertimePayrollError,type OvertimePayrollErrorCode} from '@/packs/payroll/service';
import {isCalendarDate} from '@/lib/calendar-date';

/** reason/values: a plain refusal the screen explains (duplicate code, delete blocked, conflicts); never raw error text. */
export type OvertimeActionFailure={ok:false;code:'permission'|'stale'|'invalid'|'unavailable'|'conflict'|'closed'|'limit'|'busy'|'system'|OvertimePayrollErrorCode;reference?:string;issues?:OvertimeIssue[];notice?:'chooseOneCompany';reason?:string;values?:Record<string,string|number>};
export type OvertimeActionResult<T>={ok:true;value:T}|OvertimeActionFailure;
const PAGE='/admin/attendance/settings/overtime-patterns';
async function run<T>(work:()=>Promise<T>,mutation:boolean):Promise<OvertimeActionResult<T>> {
  try {
    const value=await work();
    if(mutation) revalidatePath(PAGE);
    return {ok:true,value};
  } catch(error) {
    if(error instanceof OvertimeOwnerError) {
      const failure:OvertimeActionFailure={ok:false,code:error.code};
      if(error.detail?.reason)failure.reason=error.detail.reason;
      if(error.detail?.values)failure.values=error.detail.values;
      if(error.detail?.issues?.length)failure.issues=error.detail.issues;
      return failure;
    }
    if(error instanceof OvertimePayrollError) return {ok:false,code:error.code};
    if(error instanceof OvertimePatternError) return {ok:false,code:'invalid',issues:[error.issue]};
    const reference=`OT-${randomUUID().slice(0,8).toUpperCase()}`;
    console.error('[overtime-pattern action]',reference,error);
    return {ok:false,code:'system',reference};
  }
}
/** What the editor may post (board 4197534a). The companies are chosen in Eligibility and re-checked by the pack
 * (each administered and active, one currency). Of the definition only the day types (eligibility) and the Overtime
 * Settings table are taken from the browser; every other definition field comes from the saved draft or the chosen
 * starting template, and a saved definition that does not fit the table is kept byte-for-byte. */
export type OvertimeEditorDraft={code:string;name:string;description?:string;definition:unknown;companyIds:string[];settings?:unknown;plannedEligibility:unknown};
export type OvertimeEditorSaveInput={patternId?:string;versionId?:string;expectedRevision?:number;starterKey?:string;draft:OvertimeEditorDraft};
/** Saves keep the app frame (lib/action-navigation.ts): no revalidatePath; the editor navigates to the returned address. */
export async function saveOvertimeDraftAction(input:OvertimeEditorSaveInput) {
  const {s,scopeIds}=await scopedAdmin();
  const prepared=await run(()=>editorDraftForSave(s,scopeIds,input),false);
  if(!prepared.ok)return prepared;
  if(!prepared.value){const failure:OvertimeActionFailure={ok:false,code:'invalid',notice:'chooseOneCompany'};return failure;}
  const save=prepared.value;
  const saved=await run(()=>saveOvertimePatternDraft(s,save),false);
  if(!saved.ok)return saved;
  return {ok:true as const,value:{...saved.value,navigate:`${PAGE}?pattern=${saved.value.patternId}&version=${saved.value.versionId}&saved=${saved.value.revision}`}};
}
/** Server-derived identity and hidden definition for an editor save. A new pattern's creation company (a hidden
 * permission anchor) is the first chosen company, or with none chosen yet the first administered company of the
 * company selection; returns null when there is neither, so nothing is written. */
async function editorDraftForSave(s:Awaited<ReturnType<typeof scopedAdmin>>['s'],scopeIds:readonly string[],input:OvertimeEditorSaveInput):Promise<Parameters<typeof saveOvertimePatternDraft>[1]|null> {
  const invalid=():never=>{throw new OvertimeOwnerError('invalid','Correct the overtime pattern draft.');};
  if(!input||typeof input!=='object'||!input.draft||typeof input.draft!=='object')invalid();
  const posted=input.draft,description=typeof posted.description==='string'?posted.description:'';
  if(!Array.isArray(posted.companyIds)||posted.companyIds.length>500||posted.companyIds.some(id=>typeof id!=='string'))invalid();
  const companies=await overtimePatternWorkspaceCompanies(s),byId=new Map(companies.map(company=>[company.id,company]));
  const chosen=[...new Set(posted.companyIds)].map(id=>byId.get(id));
  if(chosen.some(company=>!company))throw new OvertimeOwnerError('permission','A company is inactive or outside your administrator scope.');
  const chosenIds=chosen.map(company=>company!.id),chosenCurrency=chosen[0]?.currency;
  const withSettings=(definition:Record<string,unknown>)=>{
    if(posted.settings===undefined)return definition;
    let settings;try{settings=parseOvertimeSettings(posted.settings);}catch{return invalid();}
    let draft;try{draft=validateOvertimePatternDraft(definition);}catch{return definition;}
    if(!definitionToOvertimeSettings(draft))return definition;
    return overtimeSettingsToDefinition(chosenCurrency?{...draft,currency:overtimeEditorCurrency(chosenCurrency)}:draft,settings) as unknown as Record<string,unknown>;
  };
  if(input.patternId!==undefined){
    if(typeof input.patternId!=='string'||typeof input.versionId!=='string')invalid();
    const detail=await getOvertimePattern(s,input.patternId),version=detail?.versions.find(item=>item.id===input.versionId);
    if(!detail||!version)throw new OvertimeOwnerError('unavailable','The overtime pattern is unavailable.');
    if(detail.pattern.kind!=='formula'||!detail.pattern.creationCompanyId||!detail.pattern.code)throw new OvertimeOwnerError('permission','Use the existing Schedule Group owner to maintain legacy overtime.');
    if(version.activatedAt||detail.pattern.archivedAt)invalid();
    if(version.revision!==input.expectedRevision)throw new OvertimeOwnerError('stale','The draft changed. Reload before saving.');
    const owning=detail.pattern.creationCompanyId;
    const draft:OvertimePatternDraft={code:detail.pattern.code,creationCompanyId:owning,companyIds:chosenIds,name:posted.name,description,plannedEligibility:posted.plannedEligibility,
      definition:withSettings(overtimeEditorDefinition(overtimeEditorBase(version.definition),posted.definition,chosenCurrency??byId.get(owning)?.currency)) as OvertimePatternDraft['definition']};
    return {patternId:detail.pattern.id,versionId:version.id,expectedRevision:input.expectedRevision,draft};
  }
  if(input.versionId!==undefined)invalid();
  const starter=input.starterKey===undefined?null:overtimeStarter(input.starterKey);
  if(input.starterKey!==undefined&&!starter)invalid();
  const creation=chosen[0]??companies.find(company=>scopeIds.includes(company.id));
  if(!creation)return null;
  return {draft:{code:posted.code,creationCompanyId:creation.id,companyIds:chosenIds,name:posted.name,description,plannedEligibility:posted.plannedEligibility,
    definition:withSettings(overtimeEditorDefinition(overtimeEditorBase(null,starter?.key),posted.definition,creation.currency)) as OvertimePatternDraft['definition']}};
}
/** Preview reads only (no lock, no write). The companies and criteria are posted as typed so Preview works before a save. */
export async function previewOvertimeEligibilityAction(input:Parameters<typeof previewOvertimePatternEligibility>[1]) {
  const {s}=await scopedAdmin();
  return run(()=>previewOvertimePatternEligibility(s,input),false);
}
/** "Activate from [date]": the saved draft with its planned Eligibility, in one transaction (pack owner). */
export async function activateOvertimePatternAction(input:{patternId:string;versionId:string;expectedRevision:number}) {
  const {s}=await scopedAdmin();
  const result=await run(()=>activateOvertimePatternWithEligibility(s,{versionId:input.versionId,expectedRevision:input.expectedRevision}),false);
  if(!result.ok)return result;
  return {ok:true as const,value:{...result.value,navigate:`${PAGE}?pattern=${encodeURIComponent(input.patternId)}&version=${result.value.versionId}&notice=activated`}};
}
/** Edit of an activated pattern opens a new draft (or the pattern's existing draft); the live rules keep applying. */
export async function editOvertimePatternAction(input:{versionId:string;expectedPatternRevision:number}) {
  const {s}=await scopedAdmin();
  const result=await run(()=>forkOvertimePatternDraft(s,input),false);
  if(!result.ok)return result;
  return {ok:true as const,value:{...result.value,navigate:`${PAGE}?pattern=${result.value.patternId}&version=${result.value.versionId}`}};
}
/** Delete = archive, refused with the reason while employees or a Schedule Group still use the pattern. */
export async function deleteOvertimePatternAction(input:{patternId:string;expectedRevision:number;note?:string}) {
  const {s}=await scopedAdmin();
  const result=await run(()=>archiveOvertimePattern(s,{patternId:input.patternId,expectedRevision:input.expectedRevision,note:typeof input.note==='string'?input.note:undefined}),false);
  if(!result.ok)return result;
  return {ok:true as const,value:{...result.value,navigate:`${PAGE}?notice=deleted`}};
}
/** Cancel an Eligibility that has not started yet. */
export async function cancelOvertimeAssignmentAction(input:Parameters<typeof cancelOvertimePatternAssignment>[1]) {
  const {s}=await scopedAdmin();
  return run(()=>cancelOvertimePatternAssignment(s,input),true);
}
export async function closeOvertimeAssignmentAction(input:Parameters<typeof closeOvertimePatternAssignment>[1]) {
  const {s}=await scopedAdmin();
  return run(()=>closeOvertimePatternAssignment(s,input),true);
}
/** Employee search for named employees, within the companies chosen in Eligibility (or the company selection). */
export async function overtimeChoicesAction(input:{employeeSearch?:string;employeeIds?:string[];employeeCursor?:string;companyIds?:string[]}) {
  const {s,scopeIds}=await scopedAdmin();
  const companyIds=Array.isArray(input?.companyIds)&&input.companyIds.length?input.companyIds:scopeIds;
  return run(()=>overtimePatternSetup(s,{employeeSearch:input?.employeeSearch,employeeIds:input?.employeeIds,employeeCursor:input?.employeeCursor,companyIds,limit:100}),false);
}

export async function previewOvertimeEmployeeAction(input:Parameters<typeof previewOvertimePatternEmployee>[1]) {
  const {s}=await scopedAdmin();
  return run(()=>previewOvertimePatternEmployee(s,input),false);
}
export async function previewOvertimeSampleAction(input:{patternId:string;versionId:string;sample:OvertimeSampleDraft}) {
  const {s}=await scopedAdmin();
  return run(async()=>{
    const sample=makeSampleInput(input.sample,s.tenantId,input.versionId);
    return previewOvertimePatternSample(s,{patternId:input.patternId,versionId:input.versionId,sample});
  },false);
}
export async function readOvertimeTransferAction(input:Parameters<typeof overtimePatternTransferOptions>[1]) {
  const {s}=await scopedAdmin();
  return run(async()=>{
    const [options,recorded]=await Promise.all([overtimePatternTransferOptions(s,input),readOvertimePatternCalculation(s,input)]);
    return {options,recorded};
  },false);
}
export async function calculateOvertimeDayAction(input:Parameters<typeof calculateOvertimePatternDay>[1]) {
  const {s}=await scopedAdmin();
  return run(()=>calculateOvertimePatternDay(s,input),true);
}
export async function transferOvertimePayrollAction(input:Parameters<typeof transferOvertimePatternToPayroll>[1]) {
  const {s}=await scopedAdmin();
  return run(()=>transferOvertimePatternToPayroll(s,input),true);
}


function makeSampleInput(sample:OvertimeSampleDraft,tenantId:string,versionId:string):OvertimeInput {
  const invalid=():never=>{throw new OvertimeOwnerError('invalid','Correct the entered sample.');};
  if(!sample||!isCalendarDate(sample.date)||!Array.isArray(sample.segments)||!sample.segments.length||sample.segments.length>OVERTIME_LIMITS.sessions||!Array.isArray(sample.resources)||sample.resources.length>128)invalid();
  if(new TextEncoder().encode(JSON.stringify(sample)).length>OVERTIME_LIMITS.jsonBytes)invalid();
  const provenance={owner:'sample' as const,reference:'entered-sample',asOf:sample.date,basis:'sample' as const};
  const known=<T>(value:T):OvertimeFact<T>=>({state:'known',value,provenance});
  const unknown={state:'unknown' as const,reason:'sample_not_entered'};
  const quantity=(value:string):OvertimeFact<string>=>value===''?unknown:known(value);
  const facts:OvertimeInput['facts']={};
  for(const [field,value] of Object.entries(sample.facts??{})) {
    if(!(OVERTIME_SAMPLE_INPUT_FIELDS as readonly string[]).includes(field))invalid();
    facts[field as keyof typeof facts]=value===''?unknown:known(value);
  }
  const segments:OvertimeRawSegment[]=[];
  for(const row of sample.segments) {
    const common={sessionId:row.sessionId};
    // This is measured segment capacity, not a physical approval interval. The entered day bound remains independent.
    if(!row.clockKnown) {const capacity=quantity(row.rawMinutes);segments.push({...common,id:row.id,rawMinutes:capacity,approvedMinutes:capacity,dayType:row.dayType?known(row.dayType):unknown,clock:unknown});continue;}
    // Sample wall-clock values explicitly use Malaysia +08:00, never the browser's local zone.
    if(sample.sessionGranularity!=='recorded'||!isCalendarDate(row.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.from)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.to)||![0,1].includes(row.endDayOffset))invalid();
    const start=Date.parse(`${row.date}T${row.from}:00+08:00`);
    const endDate=new Date(Date.parse(row.date+'T00:00:00Z')+row.endDayOffset*86400000).toISOString().slice(0,10);
    const end=Date.parse(`${endDate}T${row.to}:00+08:00`);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>86400000)invalid();
    let instant=start,index=0;
    while(instant<end) {
      const localDate=index===0?row.date:endDate;
      const localStartSecond=index===0?Number(row.from.slice(0,2))*3600+Number(row.from.slice(3))*60:0;
      const elapsedSeconds=Math.min((end-instant)/1000,86400-localStartSecond);
      segments.push({...common,id:`${row.id}_${index}`,rawMinutes:known(String(elapsedSeconds/60)),approvedMinutes:known(String(elapsedSeconds/60)),dayType:(index===0?row.dayType:row.endDayType)?known(index===0?row.dayType:row.endDayType):unknown,clock:known({startEpochSeconds:String(instant/1000),localDate,localStartSecond,elapsedSeconds})});
      instant+=elapsedSeconds*1000;index++;
    }
  }
  const inputDigest=createHash('sha256').update(JSON.stringify(sample)).digest('hex');
  return {mode:'preview',layer:'raw',sessionGranularity:sample.sessionGranularity,source:{tenantId,employmentId:randomUUID(),attendanceId:randomUUID(),date:sample.date,inputDigest,approvalDigest:inputDigest},patternVersionId:versionId,assignmentId:randomUUID(),currency:sample.currency,facts,segments,
    approval:{status:sample.approvalStatus,minutes:quantity(sample.approvalMinutes),provenance},
    resources:sample.resources.map(resource=>({id:resource.id,resource:resource.resource,evidence:resource.evidence,basis:resource.basis,sessionId:resource.basis==='session'?resource.sessionId:null,sourceKeys:[`sample_${resource.id}`],measure:{unit:resource.unit,quantity:quantity(resource.quantity)}})),
  };
}

export async function overtimePositionChoicesAction(input:{search?:string;cursor?:string;selectedIds?:string[];companyIds?:string[]}) {
 const {s,scopeIds}=await scopedAdmin();
 const companyIds=Array.isArray(input?.companyIds)&&input.companyIds.length?input.companyIds:scopeIds;
 return run(()=>overtimePositionChoices(s,{search:input?.search,cursor:input?.cursor,selectedIds:input?.selectedIds,companyIds}),false);
}
