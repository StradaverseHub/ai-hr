/** Purpose-bound positive maintenance. No role mutation, raw-row grant or financial detail read. */
import {z} from 'zod';
import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {profileOption} from '../db/schema';
import {pgSqlState} from '../lib/db-error';
import {workforceMaintenanceFields,type WorkforceMaintenanceKind,type WorkforceMaintenanceOperation,type WorkforceValue} from '../lib/workforce-maintenance-fields';
import {personnelScalarIssue} from '../lib/personnel-import-contract';
import {assertProfileValueAllowed,type ProfileOptionCategory} from './profile-options';
import {validateQualificationInputTx,QualificationValidationError,type QualificationInput} from './qualifications';
import {validateEmergencyContactInputTx,EmergencyContactValidationError,type EmergencyContactInput} from './emergency-contacts';
import {normaliseDependentPatchTx,DependentValidationError,type DependentInput} from './dependents';
import {dependentFieldApplies} from '../lib/dependent-vocabulary';
import {WorkforceAccessError} from './workforce-access';
import {WorkforceRecordChangedError} from './workforce-code';
import {WORKFORCE_PROFILE_FIELDS,type WorkforceProfile} from '../lib/workforce-record-fields';
import {lockProfileValueWritesTx} from './access-configuration-lock';
const version=z.string().regex(/^\d{1,20}$/);
const scalar=z.union([z.string().max(4000),z.boolean(),z.number().finite(),z.null()]);
const registerSchema=(kind:'qualification'|'emergency'|'dependent')=>z.object({kind:z.literal(kind),id:z.uuid(),version,
 values:z.object(Object.fromEntries(workforceMaintenanceFields(kind).map(f=>[f.key,scalar]))).strict()}).strict();
const profileSchema=z.object(Object.fromEntries(WORKFORCE_PROFILE_FIELDS.map(f=>[f.key,z.string().nullable()]))).strict();
const editorSchema=z.object({profileVersion:version,profile:profileSchema,sharedMaintain:z.boolean(),employmentMaintain:z.boolean(),registers:z.array(z.discriminatedUnion('kind',[registerSchema('qualification'),registerSchema('emergency'),registerSchema('dependent')])).max(500)}).strict();
export type WorkforceEditorRow={kind:'qualification'|'emergency'|'dependent';id:string;version:string;values:Record<string,WorkforceValue>};
export type WorkforceEditor={profileVersion:string;profile:WorkforceProfile;sharedMaintain:boolean;employmentMaintain:boolean;registers:WorkforceEditorRow[];options:{category:string;value:string;label:string}[]};
export class WorkforceMaintenanceValidationError extends Error{
 constructor(){super('Employee record input is invalid.');this.name='WorkforceMaintenanceValidationError';}
}
export class WorkforceMaintenanceUnavailableError extends Error{
 constructor(){super('Employee record setup requires review.');this.name='WorkforceMaintenanceUnavailableError';}
}
const CATEGORIES=['salutation','religion','race','nationality','state','country','relationship','qualificationLevel','dependentRelationship'] as const;
async function editorTx(tx:Tx,employmentId:string):Promise<WorkforceEditor|null>{
 const [row]=await tx.execute<{editor:unknown}>(sql`select app.access_workforce_editor(${employmentId}::uuid) as editor`);
 if(row?.editor==null)return null;
 const parsed=editorSchema.parse(row.editor);
 const options=await tx.select({category:profileOption.category,value:profileOption.value,label:profileOption.label}).from(profileOption)
  .where(and(inArray(profileOption.category,[...CATEGORIES]),eq(profileOption.isActive,true))).orderBy(asc(profileOption.sortOrder),asc(profileOption.value)).limit(4001);
 if(options.length>4000)throw new WorkforceMaintenanceUnavailableError();
 return {...parsed,profile:parsed.profile as WorkforceProfile,registers:parsed.registers as WorkforceEditorRow[],options};
}
export async function workforceEditor(ctx:SessionContext,employmentId:string){
 try{return await withTenant(ctx,tx=>editorTx(tx,employmentId));}
 catch(error){if(pgSqlState(error)==='54000')throw new WorkforceMaintenanceUnavailableError();throw error;}
}
export async function maintainWorkforceRecord(ctx:SessionContext,p:{employmentId:string;kind:WorkforceMaintenanceKind;rowId:string|null;operation:WorkforceMaintenanceOperation;patch:Record<string,unknown>;expectedVersion:string|null}){
 try{return await withTenant(ctx,async tx=>{
  await lockProfileValueWritesTx(tx,ctx.tenantId);
  const workspace=await editorTx(tx,p.employmentId);
  if(!workspace||!(p.kind==='qualification'?workspace.employmentMaintain:workspace.sharedMaintain))throw new WorkforceAccessError();
  const existing=p.rowId?workspace.registers.find(row=>row.id===p.rowId&&row.kind===p.kind):null;
  if(p.kind!=='person'&&p.operation!=='add'&&!existing)throw new WorkforceRecordChangedError();
  if(p.operation!=='add'&&p.expectedVersion!==(p.kind==='person'?workspace.profileVersion:existing!.version))throw new WorkforceRecordChangedError();
  const fields=workforceMaintenanceFields(p.kind),known=new Map(fields.map(f=>[f.key,f.field]));
  if(!p.patch||Array.isArray(p.patch)||Object.keys(p.patch).length>40||Object.keys(p.patch).some(key=>!known.has(key)))throw new WorkforceMaintenanceValidationError();
  const old:Record<string,WorkforceValue>=p.kind==='person'?workspace.profile:existing?.values??{};
  const patch:Record<string,WorkforceValue>={};
  if(p.operation!=='archive')for(const [key,raw]of Object.entries(p.patch)){
   const field=known.get(key)!;
   if(p.kind==='dependent'){
    const relationship=typeof p.patch.relationship==='string'?p.patch.relationship:old.relationship;
    if(!dependentFieldApplies(String(relationship??''),key))continue;
   }
   if(raw!==null&&typeof raw!=='string'&&typeof raw!=='boolean'&&typeof raw!=='number'||typeof raw==='string'&&raw.length>4000)throw new WorkforceMaintenanceValidationError();
   const next=key==='childReliefPercentage'&&raw!==null&&raw!==''?Number(raw):typeof raw==='string'?raw.trim()||null:raw as WorkforceValue;
   if(next===old[key])continue;
   const nullableBoolean=p.kind==='dependent'&&['spouseWorking','isStudent','childTaxRelief'].includes(key);
   if(field.type==='boolean'?typeof next!=='boolean'&&!(nullableBoolean&&next===null):key==='childReliefPercentage'?next!==null&&![50,100].includes(Number(next)):next!==null&&typeof next!=='string')throw new WorkforceMaintenanceValidationError();
   if(field.form?.required?.record&&(next==null||next===''))throw new WorkforceMaintenanceValidationError();
   if(typeof next==='string'&&!(p.kind==='dependent'&&key==='relationship')&&personnelScalarIssue(field,next))throw new WorkforceMaintenanceValidationError();
   if(field.allowedValuesOwner?.startsWith('profile_option:')&&!(p.kind==='dependent'&&key==='studyCountry')){
    const retainedRelationship=p.kind==='emergency'&&key==='relationship'&&typeof next==='string'&&workspace.registers.some(row=>row.kind==='emergency'&&row.values.relationship===next);
    await assertProfileValueAllowed(tx,field.allowedValuesOwner.slice(15) as ProfileOptionCategory,next as string|null,retainedRelationship?next as string:(old[key] as string|null)??null);
   }
   patch[key]=next;
  }
  if(p.kind==='qualification'&&p.operation!=='archive'){
   Object.assign(patch,await validateQualificationInputTx(tx,patch as Partial<QualificationInput>,existing?old as unknown as {qualification:string;fromYm:string|null;toYm:string|null;graduationDate:string|null}:undefined));
  }
  if(p.kind==='emergency'&&p.operation!=='archive'){
   if(p.operation==='add'&&(typeof patch.fullName!=='string'||!patch.fullName))throw new WorkforceMaintenanceValidationError();
   const value=patch.relationship;
   const retained=typeof value==='string'&&workspace.registers.some(row=>row.kind==='emergency'&&row.values.relationship===value);
   Object.assign(patch,await validateEmergencyContactInputTx(tx,null,patch as Partial<EmergencyContactInput>,existing||retained?{relationship:retained?value as string:old.relationship as string|null}:undefined));
  }
  if(p.kind==='dependent'&&p.operation!=='archive'){
   const normalized=await normaliseDependentPatchTx(tx,patch as Partial<DependentInput>,existing?{fullName:String(old.fullName),relationship:String(old.relationship)}:undefined);
   Object.assign(patch,Object.fromEntries(Object.entries(normalized).filter(([key])=>known.has(key))));
  }
  const [result]=await tx.execute<{result:{id:string;changed:boolean;payrollReviewRequired?:boolean}}>(sql`select app.access_workforce_maintain_record(${p.employmentId}::uuid,${p.kind},${p.rowId}::uuid,${p.operation},${JSON.stringify(patch)}::jsonb,${p.expectedVersion}) as result`);
  if(!result?.result||typeof result.result.id!=='string'||typeof result.result.changed!=='boolean')throw new Error('Workforce command result unavailable');
  if(result.result.payrollReviewRequired!==undefined&&typeof result.result.payrollReviewRequired!=='boolean')throw new Error('Workforce consequence result unavailable');
  return result.result;
 });}catch(error){
  const state=pgSqlState(error);
  if(state==='42501')throw new WorkforceAccessError();
  if(state==='40001')throw new WorkforceRecordChangedError();
  if(state==='0A000'||state==='54000')throw new WorkforceMaintenanceUnavailableError();
  if(['22023','22007','22008','22P02','23505','23514'].includes(state??'')||error instanceof QualificationValidationError||error instanceof EmergencyContactValidationError||error instanceof DependentValidationError||error instanceof Error&&error.name==='ProfileOptionValueError')throw new WorkforceMaintenanceValidationError();
  throw error;
 }
}
