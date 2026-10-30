/** Pure contract/transport checks; actual native deletion proof remains SQL-owned. */
import {expect,it} from 'vitest';
import {EmployeeDraftDiscard as C,EmployeeDraftDiscardBrowserPacket as Packet,parseEmployeeDraftDiscardBrowserResult as parse} from '../lib/assistant-actions/employee-draft-discard-contract';
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const selection={draftId:id,companyId:id},human={action:C.action,contractVersion:1,...selection,consent:'discard_saved_draft_captured_input'};
const review={...selection,companyName:'Authorized company',draftLabel:'Saved draft',scope:'saved_draft_without_any_linked_onboarding_case',capturedInput:'saved_draft_row_deleted_without_application_undo',reservedCodeOutcome:{kind:'retained_gap',reservedEmployeeCode:'HELD-0042'},consequence:'native_saved_draft_deleted_not_employee'};
const prepared={action:C.action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64),createdAt:'2026-10-30T00:00:00.000Z',expiresAt:'2026-10-30T00:10:00.000Z',content:human,review};
const prepare={action:C.action,operation:'prepare',input:human},response={kind:'prepared',review:prepared};
const retired={kind:'retired',receipt:{action:C.action,contractVersion:1,actionId:id,state:'discarded'}};
const reopen={action:C.action,operation:'reopen',actionId:id};
it('accepts only a saved draft/company nomination and explicit consent to discard the saved captured input',()=>{
 expect(Packet.parse(prepare)).toEqual(prepare);expect(C.Selection.parse(selection)).toEqual(selection);
 for(const input of [{...human,consent:false},{...human,consent:true},{...human,consent:'activate'},{...selection},{...human,draftId:undefined},{...human,companyId:null}])expect(Packet.safeParse({...prepare,input}).success).toBe(false);
});
it('rejects model-supplied values, authority, reserved-number decisions and fake subject identities at entry',()=>{
 for(const extra of [{data:{bankAccountNo:'private'}},{fields:[]},{reservedNumber:42},{released:true},{counterAfter:0},{personId:id},{employmentId:id},{actor:'hr_admin'},{tenantId:id},{status:'saved'},{confirmed:true}])expect(C.Human.safeParse({...human,...extra}).success).toBe(false);
});
it('cannot carry private captured input or other-people data at any human response layer',()=>{
 for(const [target,extra]of [['outer',{data:{}}],['prepared',{sourceCommitment:'b'.repeat(64)}],['review',{capturedInputJson:{salary:9000}}],['review',{authorPersonId:other}],['review',{config:{increment:5}}],['outcome',{currentRunningNumber:42}],['outcome',{eventId:id}]] as const){
  const value=structuredClone(response);
  Object.assign(target==='outer'?value:target==='prepared'?value.review:target==='review'?value.review.review:value.review.review.reservedCodeOutcome,extra);
  expect(()=>parse(prepare,value)).toThrow();
 }
});
it.each(['no_reservation','unreserved_code','released_tip','retained_gap'])('displays only the bounded native %s consequence without counter arithmetic',kind=>{
 const outcome=kind==='no_reservation'?{kind,reservedEmployeeCode:null}:{kind,reservedEmployeeCode:'HELD-0042'};
 expect(()=>parse(prepare,{kind:'prepared',review:{...prepared,review:{...review,reservedCodeOutcome:outcome}}})).not.toThrow();
 for(const extra of [{reservedNumber:42},{increment:5},{expectedCounter:37},{configId:id},{released:kind==='released_tip'}])expect(C.ReservedCodeOutcome.safeParse({...outcome,...extra}).success).toBe(false);
});
it('can display a saved identifier without a numeric reservation without guessing its origin or numeric meaning',()=>{
 for(const reservedEmployeeCode of ['MANUAL-0042','EMP-0042','0042','人員甲']){
  const outcome={kind:'unreserved_code',reservedEmployeeCode};expect(C.ReservedCodeOutcome.parse(outcome)).toEqual(outcome);
  expect(()=>parse(prepare,{kind:'prepared',review:{...prepared,review:{...review,reservedCodeOutcome:outcome}}})).not.toThrow();
  for(const extra of [{origin:'manual'},{sequenceUnchanged:true},{numericReservation:null},{gap:true}])expect(C.ReservedCodeOutcome.safeParse({...outcome,...extra}).success).toBe(false);
 }
});
it('refuses contradictory reservation labels and empty or unbounded held identifiers',()=>{
 for(const value of [{kind:'no_reservation',reservedEmployeeCode:'HELD-1'},{kind:'unreserved_code',reservedEmployeeCode:null},{kind:'unreserved_code',reservedEmployeeCode:''},{kind:'unreserved_code',reservedEmployeeCode:'MANUAL-1',released:false},{kind:'unreserved_code',reservedEmployeeCode:'MANUAL-1',reservedNumber:42},{kind:'released_tip',reservedEmployeeCode:null},{kind:'retained_gap',reservedEmployeeCode:''},{kind:'released_tip',reservedEmployeeCode:'x'.repeat(513)},{kind:'released_tip',reservedEmployeeCode:'HELD-1',retainedGap:true}])expect(C.ReservedCodeOutcome.safeParse(value).success).toBe(false);
});
it.each(['draftId','companyId'] as const)('binds both internal review layers and the prepare request to the same %s',field=>{
 expect(()=>parse(prepare,{kind:'prepared',review:{...prepared,review:{...review,[field]:other}}})).toThrow();
 expect(()=>parse(prepare,{kind:'prepared',review:{...prepared,content:{...human,[field]:other},review:{...review,[field]:other}}})).toThrow();
});
it('compares human selection semantically rather than rejecting reordered JSON object keys',()=>{
 const reordered={consent:human.consent,companyId:id,draftId:id,contractVersion:1,action:C.action};expect(parse({...prepare,input:reordered},response)).toEqual(response);
});
it('binds reopen to its action identity without trusting a caller-supplied draft selector',()=>{
 expect(parse(reopen,response)).toEqual(response);expect(()=>parse({...reopen,actionId:other},response)).toThrow();expect(Packet.safeParse({...reopen,selection}).success).toBe(false);
});
it('prevents action/operation confusion and foreign review retirement',()=>{
 const retire={action:C.action,operation:'retire',confirmation:{action:C.action,contractVersion:1,actionId:id}};expect(parse(retire,retired)).toEqual(retired);
 for(const [packet,result]of [[prepare,retired],[retire,response],[{...reopen,action:C.action+'.activate'},response],[retire,{...retired,receipt:{...retired.receipt,actionId:other}}]])expect(()=>parse(packet,result)).toThrow();
 expect(()=>parse({...prepare,actor:'hr_admin'},response)).toThrow();
});
it('requires complete native receipt references and binds confirmation responses to the exact selected subject',()=>{
 const confirm={action:C.action,operation:'confirm',confirmation:{...human,actionId:id,reviewedDigest:'a'.repeat(64)}};
 const receipt={kind:'discarded',...selection,eventId:id,reservedCodeOutcome:review.reservedCodeOutcome,capturedInput:review.capturedInput,consequence:C.consequence};
 const completed={kind:'completed',receipt:{action:C.action,contractVersion:1,actionId:id,state:'completed',receipt}};
 expect(parse(confirm,completed)).toEqual(completed);
 for(const value of [response,{kind:'completed',receipt:{draftId:id,eventId:id}},{...completed,receipt:{...completed.receipt,actionId:other}},{...completed,receipt:{...completed.receipt,receipt:{...receipt,draftId:other}}},{...completed,receipt:{...completed.receipt,receipt:{...receipt,companyId:other}}}])expect(()=>parse(confirm,value)).toThrow();
 expect(Packet.safeParse({...confirm,confirmation:{...confirm.confirmation,consent:false}}).success).toBe(false);
});
it('uses honest workflow handoffs for unsupported source shapes without adding private diagnostics',()=>{
 for(const reason of ['unassigned_company','linked_onboarding_case','unsupported_reservation_shape','native_discard_refused','source_out_of_bounds'])expect(parse(prepare,{kind:'handoff',reason,route:'/admin/personnel/new'})).toEqual({kind:'handoff',reason,route:'/admin/personnel/new'});
 for(const extra of [{message:'Private candidate salary'},{caseId:id},{rawDraft:{}},{currentCounter:42}])expect(C.Handoff.safeParse({kind:'handoff',reason:'linked_onboarding_case',route:'/admin/personnel/new',...extra}).success).toBe(false);
});
it('checks a positive time interval and strict versioned review envelope',()=>{
 for(const patch of [{expiresAt:prepared.createdAt},{expiresAt:'2026-10-29T23:59:59.000Z'},{createdAt:'not-a-date'},{reviewedDigest:'A'.repeat(64)},{contractVersion:2}])expect(C.Prepared.safeParse({...prepared,...patch}).success).toBe(false);
});
it('enforces serialized UTF-8 review budget without silently truncating or normalizing Unicode',()=>{
 const ascii={...prepared,review:{...review,companyName:'x'.repeat(2000),draftLabel:'x'.repeat(2000)}};expect(C.Prepared.safeParse(ascii).success).toBe(true);
 const unicode={...prepared,review:{...review,companyName:'🙂'.repeat(1000),draftLabel:'🙂'.repeat(1000)}};expect(unicode.review.companyName.length).toBe(ascii.review.companyName.length);expect(C.Prepared.safeParse(unicode).success).toBe(false);
 const distinct={...prepared,review:{...review,companyName:'公司',draftLabel:'e\u0301'}};expect(C.Prepared.parse(distinct).review.draftLabel).toBe('e\u0301');
});
it('keeps source binding private, permits a genuine USER without a linked PERSON, and rejects fake row proof',()=>{
 const source={tenantId:id,userId:id,actorPersonId:null,...selection,draftCommitment:'a'.repeat(64),counterCommitment:'b'.repeat(64),contextCommitment:'c'.repeat(64)};expect(C.PrivateSource.parse(source)).toEqual(source);
 for(const extra of [{data:{}},{draftStatus:'saved'},{physicalColumnCount:14},{xmin:'123'},{counterBefore:42},{actorEmploymentId:id},{deletionWitness:'forged'},{nativeEventId:id}])expect(C.PrivateSource.safeParse({...source,...extra}).success).toBe(false);
 expect(C.PrivateSource.safeParse({...source,userId:null}).success).toBe(false);expect(C.PrivateSource.safeParse({...source,draftCommitment:'opaque-but-not-an-exact-digest'}).success).toBe(false);
});
