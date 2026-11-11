'use server';

import {randomUUID,createHash} from 'node:crypto';
import {revalidatePath} from 'next/cache';
import {scopedAdmin} from '@/lib/scope';
import {
  saveOvertimePatternDraft, ensureOvertimePatternStarters, getOvertimePattern, overtimePatternWorkspaceCompanies,
  saveOvertimePatternAssignment, closeOvertimePatternAssignment, overtimePatternSetup, overtimePositionChoices,
  OvertimeOwnerError, previewOvertimePatternEmployee, previewOvertimePatternSample, calculateOvertimePatternDay, readOvertimePatternCalculation,
  type OvertimePatternDraft,
} from '@/packs/attendance/service';
import {overtimeEditorBase,overtimeEditorDefinition} from '@/lib/overtime-pattern-editor-scope';
import {overtimeStarter} from '@/lib/overtime-pattern-starters';
import {OvertimePatternError} from '@/lib/overtime-pattern-model';
import {OVERTIME_LIMITS,OVERTIME_SAMPLE_INPUT_FIELDS} from '@/lib/overtime-pattern-model';
import type {OvertimeIssue,OvertimeInput,OvertimeFact,OvertimeRawSegment} from '@/lib/overtime-pattern-model';
import type {OvertimeSampleDraft} from '@/lib/overtime-pattern-ui';
import {overtimePatternTransferOptions,transferOvertimePatternToPayroll,OvertimePayrollError,type OvertimePayrollErrorCode} from '@/packs/payroll/service';
import {isCalendarDate} from '@/lib/calendar-date';

export type OvertimeActionFailure={ok:false;code:'permission'|'stale'|'invalid'|'unavailable'|'conflict'|'closed'|'limit'|'busy'|'system'|OvertimePayrollErrorCode;reference?:string;issues?:OvertimeIssue[];notice?:'chooseOneCompany'};
export type OvertimeActionResult<T>={ok:true;value:T}|OvertimeActionFailure;
const PAGE='/admin/attendance/settings/overtime-patterns';
async function run<T>(work:()=>Promise<T>,mutation:boolean):Promise<OvertimeActionResult<T>> {
  try {
    const value=await work();
    if(mutation) revalidatePath(PAGE);
    return {ok:true,value};
  } catch(error) {
    if(error instanceof OvertimeOwnerError) return {ok:false,code:error.code};
    if(error instanceof OvertimePayrollError) return {ok:false,code:error.code};
    if(error instanceof OvertimePatternError) return {ok:false,code:'invalid',issues:[error.issue]};
    const reference=`OT-${randomUUID().slice(0,8).toUpperCase()}`;
    console.error('[overtime-pattern action]',reference,error);
    return {ok:false,code:'system',reference};
  }
}
/** Company selection comes from the current server session, never a posted company list. */
export async function initializeOvertimeStartersAction() {
  const {s,scopeIds}=await scopedAdmin();
  const result=await run(()=>ensureOvertimePatternStarters(s,{companyIds:scopeIds}),false);
  if(result.ok&&result.value.created>0)revalidatePath(PAGE);
  return result;
}
/** What the simplified editor may post (b31981c0). Any other field a browser sends, such as companies, currency,
 * duration policies or rates, is ignored: the server derives them from the saved pattern or new-draft defaults. */
export type OvertimeEditorDraft={code:string;name:string;description?:string;definition:unknown};
export type OvertimeEditorSaveInput={patternId?:string;versionId?:string;expectedRevision?:number;starterKey?:string;draft:OvertimeEditorDraft};
export async function saveOvertimeDraftAction(input:OvertimeEditorSaveInput) {
  const {s,scopeIds}=await scopedAdmin();
  const prepared=await run(()=>editorDraftForSave(s,scopeIds,input),false);
  if(!prepared.ok)return prepared;
  if(!prepared.value){const failure:OvertimeActionFailure={ok:false,code:'invalid',notice:'chooseOneCompany'};return failure;}
  const save=prepared.value;
  return run(()=>saveOvertimePatternDraft(s,save),true);
}
/** Server-derived identity and hidden definition for an editor save. Returns null when a new pattern has no single
 * company in the server-side company selection, so nothing is written and the editor asks for one company. */
async function editorDraftForSave(s:Awaited<ReturnType<typeof scopedAdmin>>['s'],scopeIds:readonly string[],input:OvertimeEditorSaveInput):Promise<Parameters<typeof saveOvertimePatternDraft>[1]|null> {
  const invalid=():never=>{throw new OvertimeOwnerError('invalid','Correct the overtime pattern draft.');};
  if(!input||typeof input!=='object'||!input.draft||typeof input.draft!=='object')invalid();
  const posted=input.draft,description=typeof posted.description==='string'?posted.description:'';
  if(input.patternId!==undefined){
    if(typeof input.patternId!=='string'||typeof input.versionId!=='string')invalid();
    const detail=await getOvertimePattern(s,input.patternId),version=detail?.versions.find(item=>item.id===input.versionId);
    if(!detail||!version)throw new OvertimeOwnerError('unavailable','The overtime pattern is unavailable.');
    if(detail.pattern.kind!=='formula'||!detail.pattern.creationCompanyId||!detail.pattern.code)throw new OvertimeOwnerError('permission','Use the existing Schedule Group owner to maintain legacy overtime.');
    if(version.activatedAt||detail.pattern.archivedAt)invalid();
    if(version.revision!==input.expectedRevision)throw new OvertimeOwnerError('stale','The draft changed. Reload before saving.');
    const owning=detail.pattern.creationCompanyId,companies=await overtimePatternWorkspaceCompanies(s);
    const draft:OvertimePatternDraft={code:detail.pattern.code,creationCompanyId:owning,companyIds:[...version.companyIds],name:posted.name,description,
      definition:overtimeEditorDefinition(overtimeEditorBase(version.definition),posted.definition,companies.find(company=>company.id===owning)?.currency) as OvertimePatternDraft['definition']};
    return {patternId:detail.pattern.id,versionId:version.id,expectedRevision:input.expectedRevision,draft};
  }
  if(input.versionId!==undefined)invalid();
  const starter=input.starterKey===undefined?null:overtimeStarter(input.starterKey);
  if(input.starterKey!==undefined&&!starter)invalid();
  const companies=(await overtimePatternWorkspaceCompanies(s)).filter(company=>scopeIds.includes(company.id));
  if(companies.length!==1)return null;
  const [company]=companies;
  return {draft:{code:posted.code,creationCompanyId:company.id,companyIds:[company.id],name:posted.name,description,
    definition:overtimeEditorDefinition(overtimeEditorBase(null,starter?.key),posted.definition,company.currency) as OvertimePatternDraft['definition']}};
}
export async function saveOvertimeAssignmentAction(input:Parameters<typeof saveOvertimePatternAssignment>[1]) {
  const {s}=await scopedAdmin();
  return run(()=>saveOvertimePatternAssignment(s,input),true);
}
export async function closeOvertimeAssignmentAction(input:Parameters<typeof closeOvertimePatternAssignment>[1]) {
  const {s}=await scopedAdmin();
  return run(()=>closeOvertimePatternAssignment(s,input),true);
}
export async function overtimeChoicesAction(input:{employeeSearch?:string;employeeIds?:string[];employeeCursor?:string}) {
  const {s,scopeIds}=await scopedAdmin();
  return run(()=>overtimePatternSetup(s,{...input,companyIds:scopeIds,limit:100}),false);
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

export async function overtimePositionChoicesAction(input:{search?:string;cursor?:string;selectedIds?:string[]}) {
 const {s,scopeIds}=await scopedAdmin();
 return run(()=>overtimePositionChoices(s,{...input,companyIds:scopeIds}),false);
}
