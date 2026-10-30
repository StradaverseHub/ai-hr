/** Real packet validators and streamed reader; no parser mocks, provider or server calls. */
import {expect,it} from 'vitest';
import {checkGenericPacket,readGenericModuleActionResponse} from '../components/assistant/generic-module-action-transport';
import {EmployeeCodeMaintenance as C} from '../lib/assistant-actions/employee-code-maintenance-contract';
const employmentId='84000000-0000-4000-8000-000000000001',actionId='84000000-0000-4000-8000-000000000002',eventId='84000000-0000-4000-8000-000000000003',otherId='84000000-0000-4000-8000-000000000004',base={action:C.action,contractVersion:1},times={createdAt:'2026-10-30T01:00:00.000Z',expiresAt:'2026-10-30T01:10:00.000Z'},reviewedDigest='a'.repeat(64);
const subject={employmentId,employeeName:'Fictional Dana',employeeCode:'OLD-7',companyName:'Fictional Company'},human={...base,employmentId,subjectId:employmentId,expectedCode:'OLD-7',employeeCode:' human-42 '},confirmation={...base,actionId,reviewedDigest};
const prepared=()=>({kind:'prepared',review:{...base,actionId,reviewedDigest,...times,content:human,review:{...subject,subjectId:employmentId,before:'OLD-7',after:'HUMAN-42'},consequence:C.consequence}}),completed=()=>({kind:'completed',receipt:{...base,actionId,state:'completed',receipt:{kind:'maintained',employmentId,subjectId:employmentId,eventId,before:'OLD-7',after:'HUMAN-42'}}}),retired=()=>({kind:'retired',receipt:{...base,actionId,state:'discarded'}});
const choices={kind:'choices',employees:[subject],truncated:false},index={kind:C.indexKind,reviews:[{...base,actionId,state:'awaiting_confirmation',...times}]};
function packet(value:unknown){const parsed=checkGenericPacket(value);expect(parsed).not.toBeNull();if(!parsed)throw Error('Expected finite employee-code packet');return parsed;}
function response(value:unknown){const bytes=new TextEncoder().encode(JSON.stringify(value));let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length){controller.close();return;}const end=Math.min(offset+137,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end;}}),{status:200,headers:{'Content-Type':'application/json'}});}
it.each([
 {operation:'choices',request:{action:C.action,operation:'choices',selection:{query:'Fictional',employmentId}},result:choices},
 {operation:'list',request:{action:C.action,operation:'list'},result:index},
 {operation:'prepare',request:{action:C.action,operation:'prepare',input:human},result:prepared()},
 {operation:'reopen',request:{action:C.action,operation:'reopen',actionId},result:prepared()},
 {operation:'confirm',request:{action:C.action,operation:'confirm',confirmation},result:completed()},
 {operation:'discard',request:{action:C.action,operation:'discard',confirmation:{...base,actionId}},result:retired()},
])('accepts exact $operation packet/result through the actual chunked reader',async row=>{expect(await readGenericModuleActionResponse(response(row.result),packet(row.request))).toEqual(row.result);});
it('rejects missing explicit baseline and forged authority/person/subject fields before transmission',()=>{
 for(const input of [{...human,expectedCode:undefined},{...human,actor:'hr_admin'},{...human,subjectId:otherId},{...human,personId:otherId},{...human,salary:'1000'}])expect(checkGenericPacket({action:C.action,operation:'prepare',input})).toBeNull();
});
it('rejects subject substitutions, hidden response fields and wrong saved action IDs',async()=>{
 const wrong=prepared();wrong.review.content={...human,employmentId:otherId,subjectId:otherId};wrong.review.review.employmentId=otherId;wrong.review.review.subjectId=otherId;await expect(readGenericModuleActionResponse(response(wrong),packet({action:C.action,operation:'prepare',input:human}))).rejects.toThrow();
 const other=prepared();other.review.actionId=otherId;await expect(readGenericModuleActionResponse(response(other),packet({action:C.action,operation:'reopen',actionId}))).rejects.toThrow();
 const done=completed();done.receipt.actionId=otherId;await expect(readGenericModuleActionResponse(response(done),packet({action:C.action,operation:'confirm',confirmation}))).rejects.toThrow();
 await expect(readGenericModuleActionResponse(response({...prepared(),privateDraftName:'not permitted'}),packet({action:C.action,operation:'reopen',actionId}))).rejects.toThrow();
});
it('accepts bounded Unicode canonical labels beyond the older server 20480-byte response limit',async()=>{
 const large=prepared();large.review.review.employeeName='人'.repeat(4000);large.review.review.companyName='企'.repeat(4000);const size=new TextEncoder().encode(JSON.stringify(large)).byteLength;expect(size).toBeGreaterThan(20480);expect(size).toBeLessThan(131072);expect(await readGenericModuleActionResponse(response(large),packet({action:C.action,operation:'reopen',actionId}))).toEqual(large);
});
