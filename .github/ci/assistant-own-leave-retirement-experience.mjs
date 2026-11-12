/** UNRUN, import-safe real UI retirement journey. Only observe real responses and use mounted
 * controls. No injected session/cookie, HTTP command, intercepted route, SQL write or forced expiry.
 * The controller supplies an independently implemented read-only native verifier and isolated unit. */
export const OWN_LEAVE_RETIREMENT_CHECKS=Object.freeze(['prepare_private_body_no_native_effect','explicit_ui_discard_retires_encrypted_body','reload_reopen_same_discarded_receipt','repeat_retired_reopen_no_request_event_provider_effect']);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=code=>{throw Error('assistant_own_leave_retirement:'+code);};
const requireFact=(v,code)=>{if(!v)fail(code);};
const keys=(v,list)=>v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),[...list].sort());
function operation(request){try{return request.method()==='POST'&&new URL(request.url()).pathname==='/api/assistant/own-leave'?request.postDataJSON()?.operation:null;}catch{return null;}}
async function responseFor(page,op,click){
 const pending=page.waitForResponse(r=>new URL(r.url()).origin===new URL(page.url()).origin&&operation(r.request())===op,{timeout:30000});
 let response;try{await click();response=await pending;}catch(error){void pending.catch(()=>{});throw error;}
 requireFact(response.ok()&&response.headers()['content-type']?.split(';')[0].trim()==='application/json','response');
 const text=await response.text();requireFact(Buffer.byteLength(text,'utf8')<=65536,'response_bound');try{return JSON.parse(text);}catch{fail('response_json');}
}
export function discardedReceipt(result,actionId){
 const r=result?.receipt;requireFact(keys(result,['kind','receipt'])&&result.kind==='retired'&&keys(r,['actionId','contractVersion','state'])&&r.actionId===actionId&&r.contractVersion===1&&r.state==='discarded','retired_receipt');return r;
}
export function assertRetirementNativeFacts(facts,expected,baseline,state){
 const names=['totalTenantRequests','totalTenantSubmissionEvents','matchingRequests','matchingSubmissionEvents','totalTenantModelRuns'];
 requireFact(facts?.currentActorUserId===expected.userId&&keys(facts.counts,names)&&names.every(n=>Number.isSafeInteger(facts.counts[n])&&facts.counts[n]>=0)&&facts.request===null&&facts.event===null,'native_identity_counts');
 requireFact(facts.counts.matchingRequests===0&&facts.counts.matchingSubmissionEvents===0&&facts.counts.totalTenantModelRuns===0,'native_effect');
 if(baseline)requireFact(same(facts.counts,baseline),'native_changed');
 if(state===null)requireFact(facts.custody===null,'baseline_custody');
 else requireFact(keys(facts.custody,['state','bodyCount','digestsPresent','pairedRefsPresent'])&&facts.custody.state===state&&facts.custody.bodyCount===(state==='awaiting_confirmation'?1:0)&&facts.custody.digestsPresent===(state==='awaiting_confirmation')&&facts.custody.pairedRefsPresent===false,'native_retirement');
 return structuredClone(facts.counts);
}
export async function runAssistantOwnLeaveRetirementEnglishExperience({page,fixture,verifyCanonical}){
 requireFact(page&&typeof page.goto==='function'&&typeof verifyCanonical==='function','page_verifier');
 const self=fixture?.actors?.self,leave=fixture?.workforce?.leave,selection=leave?.self;
 requireFact(fixture?.state==='native_prerequisites_prepared_not_experienced'&&fixture.limits?.uiTargetEffects==='not_executed'&&uuid(self?.userId)&&uuid(self?.employmentId)&&uuid(leave?.annualTypeId)&&/^\d{4}-\d{2}-\d{2}$/.test(selection?.date??'')&&selection.deductionDays===1&&typeof selection.humanText?.reason==='string'&&selection.humanText.reason.length>0&&typeof selection.humanText?.employeeRemark==='string'&&selection.humanText.employeeRemark.length>0,'fixture');
 const url=new URL(page.url());requireFact(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.port,'loopback');
 const expected={userId:self.userId,employmentId:self.employmentId,leaveTypeId:leave.annualTypeId,date:selection.date,humanText:{...selection.humanText}},ops=[];let stage='baseline',unexpected=false;
 const observe=request=>{const op=operation(request);if(op!==null){if(!['prepare','discard','list','reopen'].includes(op)||ops.length>=12)unexpected=true;ops.push(op);}};page.on('request',observe);
 try{
  const baseline=assertRetirementNativeFacts(await verifyCanonical({phase:'baseline',expected}),expected,null,null);
  requireFact(baseline.totalTenantRequests===fixture.expectedNative?.baselineLeaveRequests&&baseline.totalTenantSubmissionEvents===fixture.expectedNative?.baselineSubmittedEvents,'fixture_baseline');
  stage='actual_english_chooser';await page.goto(new URL('/assistant/leave',url.origin).href,{waitUntil:'domcontentloaded'});
  if(await page.locator('html').getAttribute('lang')!=='en'){await page.getByRole('button',{name:'Change language',exact:true}).click();await page.getByRole('button',{name:'English',exact:true}).click();}
  await page.getByRole('heading',{name:'Review my leave request',exact:true}).waitFor({state:'visible'});
  const panel=page.getByRole('region',{name:'Saved leave review',exact:true});await panel.waitFor({state:'visible'});
  for(const [label,value]of [['Your employment',self.employmentId],['Leave type',leave.annualTypeId]])await panel.getByLabel(label,{exact:true}).selectOption(value);
  for(const [label,value]of [['Leave date',selection.date],['Your reason',selection.humanText.reason],['Your employee remark',selection.humanText.employeeRemark]])await panel.getByLabel(label,{exact:true}).fill(value);
  stage='prepared_without_effect';const prepared=await responseFor(page,'prepare',()=>panel.getByRole('button',{name:'Prepare leave review',exact:true}).click()),review=prepared?.review,actionId=review?.actionId;
  requireFact(keys(prepared,['kind','review'])&&prepared.kind==='prepared'&&uuid(actionId)&&review.contractVersion===1&&review.date===expected.date&&review.deductionDays===1&&same(review.humanText,expected.humanText)&&Date.parse(review.expiresAt)>Date.now(),'prepared_binding');
  const native=await verifyCanonical({phase:'prepared',expected,actionId,review});assertRetirementNativeFacts(native,expected,baseline,'awaiting_confirmation');
  const projected=['companyName','employeeCode','leaveTypeName','date','durationType','deductionDays','availableBalance','estimatedAvailableAfter','humanText','holidayWarnings','approvalRouting'];requireFact(native.reviewProjection&&projected.every(k=>same(native.reviewProjection[k],review[k])),'canonical_review');
  stage='explicit_discard';const receipt=discardedReceipt(await responseFor(page,'discard',()=>panel.getByRole('button',{name:'Discard saved review',exact:true}).click()),actionId);
  await panel.getByRole('status').filter({hasText:'Saved review discarded. This does not cancel a leave request.'}).waitFor({state:'visible'});
  assertRetirementNativeFacts(await verifyCanonical({phase:'discarded',expected,actionId,receipt}),expected,baseline,'discarded');
  async function reopen(phase){
   await page.reload({waitUntil:'domcontentloaded'});await panel.waitFor({state:'visible'});
   const index=await responseFor(page,'list',()=>panel.getByRole('button',{name:'Find my saved reviews',exact:true}).click());
   requireFact(keys(index,['kind','reviews'])&&index.kind==='review_index'&&Array.isArray(index.reviews)&&index.reviews.length<=25,'index');
   const pos=index.reviews.findIndex(r=>r.actionId===actionId);requireFact(pos>=0&&index.reviews.filter(r=>r.actionId===actionId).length===1&&index.reviews[pos].state==='discarded','same_index');
   const buttons=panel.getByRole('button',{name:/^Open saved review:/});requireFact(await buttons.count()===index.reviews.length,'index_controls');
   const actual=discardedReceipt(await responseFor(page,'reopen',()=>buttons.nth(pos).click()),actionId);requireFact(same(actual,receipt),'same_receipt');
   await panel.getByRole('status').filter({hasText:'Saved review discarded. This does not cancel a leave request.'}).waitFor({state:'visible'});
   requireFact(await panel.getByRole('button',{name:'Submit this leave request',exact:true}).count()===0,'retired_not_confirmable');
   assertRetirementNativeFacts(await verifyCanonical({phase,expected,actionId,receipt:actual}),expected,baseline,'discarded');
  }
  stage='reload_retired';await reopen('reopened');stage='repeat_retired';await reopen('reopened_again');
  requireFact(!unexpected&&same(ops,['prepare','discard','list','reopen','list','reopen']),'only_retirement_operations');
  return{journey:'english_own_leave_retirement',checks:OWN_LEAVE_RETIREMENT_CHECKS.map(id=>({id,passed:true})),coverage:'fictional_english_discard_and_readonly_retired_reopen_only',notCovered:['expiry_cleanup','privacy_erasure','lost_response','duplicate_confirm','cross_scope_revocation','other_locales_mobile_accessibility','production_authentication_provider_combined_gate']};
 }catch{fail(stage);}finally{page.off('request',observe);}
}
