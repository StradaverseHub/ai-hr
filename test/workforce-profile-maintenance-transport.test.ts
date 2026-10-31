/** Actual browser packet schemas and streamed response reader; no parser mocks or server effects. */
import {describe,expect,it} from 'vitest';
import {checkGenericPacket,readGenericModuleActionResponse} from '../components/assistant/generic-module-action-transport';
import {WorkforceProfileMaintenance as C} from '../lib/assistant-actions/workforce-profile-maintenance-contract';
import {workforceMaintenanceFields} from '../lib/workforce-maintenance-fields';
const employmentId='81000000-0000-4000-8000-000000000001',actionId='81000000-0000-4000-8000-000000000002',eventId='81000000-0000-4000-8000-000000000003',otherId='81000000-0000-4000-8000-000000000004';
const base={action:C.action,contractVersion:1},subject={employmentId,subjectId:employmentId,employeeName:'Fictional Dana',employeeCode:'FIC-1',companyName:'Fictional Company'},times={createdAt:'2026-10-30T01:00:00.000Z',expiresAt:'2026-10-30T01:10:00.000Z'},reviewedDigest='a'.repeat(64);
function values():Record<string,string|null>{return Object.fromEntries(workforceMaintenanceFields('person','personal').map(({key})=>[key,key==='fullName'?'Fictional Dana':null]));}
const human=()=>{const fields:Record<string,string|null>={...values(),preferredName:'Fictional revised name'};return{...base,employmentId,subjectId:employmentId,section:'personal' as const,expectedVersion:'1042',values:fields};};
const prepared=()=>({kind:'prepared' as const,review:{...base,actionId,reviewedDigest,...times,content:human(),review:{...subject,section:'personal' as const,before:values(),after:human().values,sharedPerson:true as const},consequence:C.consequence}});
const completed=()=>({kind:'completed',receipt:{...base,actionId,state:'completed',receipt:{kind:'maintained',employmentId,subjectId:employmentId,eventId,sharedPerson:true}}});
const retired=()=>({kind:'retired',receipt:{...base,actionId,state:'discarded'}});
const choices=()=>({kind:'choices',employees:[subject],truncated:false,selected:{employmentId,subjectId:employmentId,section:'personal',expectedVersion:'1042',values:values()},options:[]});
const index=()=>({kind:C.indexKind,reviews:[{...base,actionId,state:'awaiting_confirmation',...times}]});
const confirmation={...base,actionId,reviewedDigest};
function checked(value:unknown){const packet=checkGenericPacket(value);expect(packet).not.toBeNull();if(!packet)throw Error('Expected finite Workforce profile packet');return packet;}
/** Feed multiple actual Uint8Array chunks through Response.body.getReader(), including UTF-8. */
function streamed(body:unknown,onCancel?:()=>void){const bytes=new TextEncoder().encode(JSON.stringify(body));let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length){controller.close();return;}const end=Math.min(offset+1537,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end;},cancel(){onCancel?.();}}),{status:200,headers:{'Content-Type':'application/json'}});}
describe('positive Workforce profile browser transport',()=>{
 const operations=[
  {operation:'choices',packet:{action:C.action,operation:'choices',selection:{query:'Fictional',employmentId,section:'personal'}},result:choices},
  {operation:'list',packet:{action:C.action,operation:'list'},result:index},
  {operation:'prepare',packet:{action:C.action,operation:'prepare',input:human()},result:prepared},
  {operation:'reopen',packet:{action:C.action,operation:'reopen',actionId},result:prepared},
  {operation:'confirm',packet:{action:C.action,operation:'confirm',confirmation},result:completed},
  {operation:'discard',packet:{action:C.action,operation:'discard',confirmation:{...base,actionId}},result:retired},
 ];
 it.each(operations)('accepts the exact $operation packet and its streamed result',async row=>{
  const packet=checked(row.packet),result=row.result();expect(packet.action).toBe(C.action);expect(await readGenericModuleActionResponse(streamed(result),packet)).toEqual(result);
 });
 it('rejects forged human fields, subject aliases and extra authority before transmission',()=>{
  const input=human();for(const value of [{action:C.action,operation:'prepare',input:{...input,actor:'hr_admin'}},{action:C.action,operation:'prepare',input:{...input,subjectId:otherId}},{action:C.action,operation:'prepare',input:{...input,values:{...input.values,salary:'1000'}}},{action:C.action,operation:'choices',selection:{query:'Fictional',personId:otherId}},{action:C.action,operation:'confirm',confirmation:{...confirmation,confirmed:true}},{action:'employees.workforce_profile.arbitrary',operation:'list'}])expect(checkGenericPacket(value)).toBeNull();
 });
 it('rejects a prepared response substituted onto another subject or carrying hidden fields',async()=>{
  const packet=checked({action:C.action,operation:'prepare',input:human()}),wrong=prepared();wrong.review.content.employmentId=otherId;wrong.review.content.subjectId=otherId;wrong.review.review.employmentId=otherId;wrong.review.review.subjectId=otherId;
  await expect(readGenericModuleActionResponse(streamed(wrong),packet)).rejects.toThrow();
  const forged=prepared();forged.review.review.after.salary='1000';await expect(readGenericModuleActionResponse(streamed(forged),packet)).rejects.toThrow();
  const mismatched=prepared();mismatched.review.review.subjectId=otherId;await expect(readGenericModuleActionResponse(streamed(mismatched),checked({action:C.action,operation:'reopen',actionId}))).rejects.toThrow();
 });
 it('requires the saved action ID for reopen, confirmation and discard responses',async()=>{
  const reopened=prepared();reopened.review.actionId=otherId;await expect(readGenericModuleActionResponse(streamed(reopened),checked({action:C.action,operation:'reopen',actionId}))).rejects.toThrow();
  const done=completed();done.receipt.actionId=otherId;await expect(readGenericModuleActionResponse(streamed(done),checked({action:C.action,operation:'confirm',confirmation}))).rejects.toThrow();
  const discarded=retired();discarded.receipt.actionId=otherId;await expect(readGenericModuleActionResponse(streamed(discarded),checked({action:C.action,operation:'discard',confirmation:{...base,actionId}}))).rejects.toThrow();
 });
 it('accepts a schema-valid prepared review above the former 32768-byte bound through the real reader',async()=>{
  const response=prepared();for(const key of ['firstName','lastName','preferredName']){response.review.content.values[key]='人'.repeat(1200);response.review.review.after[key]='人'.repeat(1200);response.review.review.before[key]='名'.repeat(1200);}
  const bytes=new TextEncoder().encode(JSON.stringify(response)).byteLength;expect(bytes).toBeGreaterThan(32768);expect(bytes).toBeLessThan(120000);expect(C.Prepared.safeParse(response.review).success).toBe(true);
  const packet=checked({action:C.action,operation:'prepare',input:response.review.content});expect(await readGenericModuleActionResponse(streamed(response),packet)).toEqual(response);
 });
 it('rejects a streamed body above the 131072-byte Workforce response budget',async()=>{
  const packet=checked({action:C.action,operation:'reopen',actionId});let cancelled=false;await expect(readGenericModuleActionResponse(streamed({...prepared(),padding:'x'.repeat(131072)},()=>{cancelled=true;}),packet)).rejects.toThrow();expect(cancelled).toBe(true);
 });
});
