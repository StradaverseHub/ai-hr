/** Real packet validators and streamed reader; no parser mocks, provider or server calls. */
import {expect,it} from 'vitest';
import {checkGenericPacket,readGenericModuleActionResponse} from '../components/assistant/generic-module-action-transport';
import {FixedItemArchive as C} from '../lib/assistant-actions/fixed-item-archive-contract';
const employmentId='84000000-0000-4000-8000-000000000001',actionId='84000000-0000-4000-8000-000000000002',eventId='84000000-0000-4000-8000-000000000003',otherId='84000000-0000-4000-8000-000000000004',id='84000000-0000-4000-8000-000000000005',base={action:C.action,contractVersion:1},times={createdAt:'2026-10-30T01:00:00.000Z',expiresAt:'2026-10-30T01:10:00.000Z'},reviewedDigest='a'.repeat(64);
const subject={employmentId,employeeName:'Fictional Dana',employeeCode:'FIC-7',companyName:'Fictional Company'},human={...base,employmentId,subjectId:id},confirmation={...base,actionId,reviewedDigest};
const fields={componentId:otherId,code:'ALLOWANCE',name:'Fictional allowance',amount:'220.25',currency:'MYR',validFrom:'2026-10-01',validTo:null,prorateOverride:null,remarks:'Human saved note',runType:null,payrollCycleId:null,archived:false};
const prepared=()=>({kind:'prepared',review:{...base,actionId,reviewedDigest,...times,content:human,review:{...subject,subjectId:id,before:fields,after:{...fields,archived:true},processedPeriods:['2026-10']},consequence:C.consequence}}),completed=()=>({kind:'completed',receipt:{...base,actionId,state:'completed',receipt:{kind:'archived',employmentId,subjectId:id,eventId}}}),retired=()=>({kind:'retired',receipt:{...base,actionId,state:'discarded'}});
const choices={kind:'choices',employees:[subject],truncated:false,items:[{id,fields}]},index={kind:C.indexKind,reviews:[{...base,actionId,state:'awaiting_confirmation',...times}]};
function packet(value:unknown){const parsed=checkGenericPacket(value);expect(parsed).not.toBeNull();if(!parsed)throw Error('Expected finite fixed archive packet');return parsed;}
function response(value:unknown){const bytes=new TextEncoder().encode(JSON.stringify(value));let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length){controller.close();return;}const end=Math.min(offset+137,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end;}}),{status:200,headers:{'Content-Type':'application/json'}});}
it.each([
 {operation:'choices',request:{action:C.action,operation:'choices',selection:{query:'Fictional',employmentId}},result:choices},
 {operation:'list',request:{action:C.action,operation:'list'},result:index},
 {operation:'prepare',request:{action:C.action,operation:'prepare',input:human},result:prepared()},
 {operation:'reopen',request:{action:C.action,operation:'reopen',actionId},result:prepared()},
 {operation:'confirm',request:{action:C.action,operation:'confirm',confirmation},result:completed()},
 {operation:'discard',request:{action:C.action,operation:'discard',confirmation:{...base,actionId}},result:retired()},
])('accepts exact $operation packet/result through the actual chunked reader',async row=>{expect(await readGenericModuleActionResponse(response(row.result),packet(row.request))).toEqual(row.result);});
it('rejects inferred values and authority before transmission',()=>{for(const extra of [{amount:'999.00'},{fields},{allowClosedPeriod:true},{operation:'end'},{actor:'hr_admin'}])expect(checkGenericPacket({action:C.action,operation:'prepare',input:{...human,...extra}})).toBeNull();});
it('rejects subject substitution, forged after-state/private fields and wrong saved action ID',async()=>{
 const wrong=prepared();wrong.review.content.subjectId=otherId;wrong.review.review.subjectId=otherId;await expect(readGenericModuleActionResponse(response(wrong),packet({action:C.action,operation:'prepare',input:human}))).rejects.toThrow();
 const other=prepared();other.review.actionId=otherId;await expect(readGenericModuleActionResponse(response(other),packet({action:C.action,operation:'reopen',actionId}))).rejects.toThrow();
 const forged=prepared();forged.review.review.after.amount='999.00';await expect(readGenericModuleActionResponse(response(forged),packet({action:C.action,operation:'reopen',actionId}))).rejects.toThrow();
 await expect(readGenericModuleActionResponse(response({...prepared(),bankAccountNo:'PRIVATE'}),packet({action:C.action,operation:'reopen',actionId}))).rejects.toThrow();
});
it('reads a valid canonical Unicode review above32768 and below120000 with the actual131072 byte stream budget',async()=>{
 const large=prepared();large.review.review.before={...fields,remarks:'人'.repeat(8000)};large.review.review.after={...large.review.review.before,archived:true};const size=new TextEncoder().encode(JSON.stringify(large)).byteLength;expect(size).toBeGreaterThan(32768);expect(size).toBeLessThan(120000);expect(await readGenericModuleActionResponse(response(large),packet({action:C.action,operation:'reopen',actionId}))).toEqual(large);
});
