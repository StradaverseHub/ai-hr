/** IMPORT-SAFE SOURCE PROPOSAL, UNRUN. Real UI only: no route interception, request injection,
 * mocked transport, session/cookie injection, server-action invocation or business SQL writes.
 * Parent must already own an admitted fictional app/DB and log in via its actual header chooser.
 * Canonical verifier is mandatory and must use read-only actual owner/native queries, never echo
 * these expected arguments as proof. This file does not implement or authorize that verifier.
 *
 * verifyCanonical({phase,expected,actionId?,receipt?,review?}) must return actual native facts:
 * {currentActorUserId,counts:{totalTenantRequests,totalTenantSubmissionEvents,matchingRequests,
 * matchingSubmissionEvents},request:null|{id,employmentId,leaveTypeId,startDate,endDate,durationType,
 * days,reason,employeeRemark,status},event:null|{id,actorType,actorId,aggregateType,aggregateId,
 * eventType,subjectEmploymentId},reviewProjection?:{companyName,employeeCode,leaveTypeName,date,
 * durationType,deductionDays,availableBalance,estimatedAvailableAfter,humanText,holidayWarnings,
 * approvalRouting}}. The prepared phase MUST rebuild that projection through the actual fresh
 * canonical read owner. Matching means exact expected human selection/date/text.
 * IDs/text stay private in this closure/callback. The returned check metadata contains none.
 */
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const fail=code=>{throw Error('assistant_own_leave_experience:'+code);};
const requireFact=(condition,code)=>{if(!condition)fail(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&same(Object.keys(value).sort(),[...expected].sort());
function packetOperation(request){try{const url=new URL(request.url());return request.method()==='POST'&&url.pathname==='/api/assistant/own-leave'?request.postDataJSON()?.operation:null;}catch{return null;}}
async function responseFor(page,operation,click){
 const pending=page.waitForResponse(response=>new URL(response.url()).origin===new URL(page.url()).origin&&packetOperation(response.request())===operation,{timeout:30000});let response;try{await click();response=await pending;}catch(error){void pending.catch(()=>{});throw error;}
 requireFact(response.ok()&&response.headers()['content-type']?.split(';')[0].trim()==='application/json','bounded_response_missing');
 const text=await response.text();requireFact(Buffer.byteLength(text,'utf8')<=65536,'response_overflow');try{return JSON.parse(text);}catch{fail('response_invalid');}
}
function completed(result,actionId){
 requireFact(keys(result,['kind','receipt'])&&result.kind==='completed','completion_missing');const r=result.receipt;
 requireFact(keys(r,['actionId','contractVersion','state','leaveRequestId','submissionEventId'])&&r.actionId===actionId&&r.contractVersion===1&&r.state==='completed'&&uuid(r.leaveRequestId)&&uuid(r.submissionEventId),'completion_binding');return r;
}
function counts(value){const names=['totalTenantRequests','totalTenantSubmissionEvents','matchingRequests','matchingSubmissionEvents'];requireFact(value&&names.every(key=>Number.isSafeInteger(value[key])&&value[key]>=0),'native_counts_missing');return Object.fromEntries(names.map(key=>[key,value[key]]));}
function nativeIdentity(facts,expected){requireFact(facts?.currentActorUserId===expected.userId,'native_actor_mismatch');}
function nativeCompleted(facts,expected,baseline,receipt,days){
 nativeIdentity(facts,expected);const observed=counts(facts.counts);
 requireFact(same(observed,{totalTenantRequests:baseline.totalTenantRequests+1,totalTenantSubmissionEvents:baseline.totalTenantSubmissionEvents+1,matchingRequests:1,matchingSubmissionEvents:1}),'native_extra_or_missing_effect');
 const r=facts.request,e=facts.event;
 requireFact(r?.id===receipt.leaveRequestId&&r.employmentId===expected.employmentId&&r.leaveTypeId===expected.leaveTypeId&&r.startDate===expected.date&&r.endDate===expected.date&&r.durationType==='full_day'&&r.days===days&&r.reason===expected.humanText.reason&&r.employeeRemark===expected.humanText.employeeRemark&&r.status==='pending','native_request_mismatch');
 requireFact(e?.id===receipt.submissionEventId&&e.actorType==='user'&&e.actorId===expected.userId&&e.aggregateType==='leave-request'&&e.aggregateId===r.id&&e.eventType==='leave-request.submitted'&&e.subjectEmploymentId===expected.employmentId,'native_event_mismatch');
}
/** Existing Page must already be logged in as fixture.actors.self through the real UI.
 * The complete private fixture is produced by populateAiDeliveryFullFixture, not production data.
 * This only covers the English positive primary flow and repeat READONLY completed reopening. */
export async function runAssistantOwnLeaveEnglishExperience({page,fixture,verifyCanonical}){
 requireFact(page&&typeof page.goto==='function'&&typeof verifyCanonical==='function','real_page_and_native_verifier_required');
 requireFact(fixture?.state==='native_prerequisites_prepared_not_experienced'&&fixture.limits?.uiTargetEffects==='not_executed','fictional_fixture_required');
 const self=fixture.actors?.self,leave=fixture.workforce?.leave,selection=leave?.self;
 requireFact(uuid(self?.userId)&&uuid(self?.employmentId)&&uuid(leave?.annualTypeId)&&/^\d{4}-\d{2}-\d{2}$/.test(selection?.date??'')&&selection.deductionDays===1&&typeof selection.humanText?.reason==='string'&&selection.humanText.reason.length>0&&typeof selection.humanText?.employeeRemark==='string'&&selection.humanText.employeeRemark.length>0,'actual_fixture_inputs_required');
 const current=new URL(page.url());requireFact(current.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(current.hostname)&&current.port,'admitted_loopback_page_required');
 const expected={userId:self.userId,employmentId:self.employmentId,leaveTypeId:leave.annualTypeId,date:selection.date,humanText:{...selection.humanText}};
 const operations=[];let unexpected=false,stage='baseline';
 const observe=request=>{const operation=packetOperation(request);if(operation!==null){if(!['prepare','confirm','list','reopen','discard'].includes(operation)||operations.length>=16)unexpected=true;else operations.push(operation);}};
 page.on('request',observe);
 try{
  const before=await verifyCanonical({phase:'baseline',expected});nativeIdentity(before,expected);const baseline=counts(before.counts);
  requireFact(baseline.matchingRequests===0&&baseline.matchingSubmissionEvents===0&&before.request===null&&before.event===null,'native_baseline_not_empty');
  requireFact(baseline.totalTenantRequests===fixture.expectedNative?.baselineLeaveRequests&&baseline.totalTenantSubmissionEvents===fixture.expectedNative?.baselineSubmittedEvents,'fixture_baseline_changed');
  stage='english_current_own_choices';await page.goto(new URL('/assistant/leave',current.origin).href,{waitUntil:'domcontentloaded'});
  // Change language through the existing native UI, never by setting a cookie or calling its action.
  if(await page.locator('html').getAttribute('lang')!=='en'){await page.getByRole('button',{name:'Change language',exact:true}).click();await page.getByRole('button',{name:'English',exact:true}).click();}
  await page.getByRole('heading',{name:'Review my leave request',exact:true}).waitFor({state:'visible'});
  const panel=page.getByRole('region',{name:'Saved leave review',exact:true});await panel.waitFor({state:'visible'});
  await panel.getByLabel('Your employment',{exact:true}).selectOption(self.employmentId);await panel.getByLabel('Leave type',{exact:true}).selectOption(leave.annualTypeId);
  await panel.getByLabel('Leave date',{exact:true}).fill(selection.date);await panel.getByLabel('Your reason',{exact:true}).fill(selection.humanText.reason);await panel.getByLabel('Your employee remark',{exact:true}).fill(selection.humanText.employeeRemark);
  stage='prepare_without_effect';const prepared=await responseFor(page,'prepare',()=>panel.getByRole('button',{name:'Prepare leave review',exact:true}).click());
  requireFact(keys(prepared,['kind','review'])&&prepared.kind==='prepared','saved_review_missing');const review=prepared.review,actionId=review?.actionId;
  requireFact(uuid(actionId)&&review.contractVersion===1&&review.date===expected.date&&review.deductionDays===1&&same(review.humanText,expected.humanText)&&/^[a-f0-9]{64}$/.test(review.humanIntentDigest??'')&&Date.parse(review.expiresAt)>Date.now(),'saved_review_binding');
  const noEffect=await verifyCanonical({phase:'prepared',expected,actionId,review});nativeIdentity(noEffect,expected);requireFact(same(counts(noEffect.counts),baseline)&&noEffect.request===null&&noEffect.event===null,'prepare_changed_native_effects');
  const projectionKeys=['companyName','employeeCode','leaveTypeName','date','durationType','deductionDays','availableBalance','estimatedAvailableAfter','humanText','holidayWarnings','approvalRouting'];
  requireFact(noEffect.reviewProjection&&projectionKeys.every(key=>same(noEffect.reviewProjection[key],review[key])),'native_review_projection_mismatch');
  stage='literal_saved_review';
  const datum=label=>panel.locator('dl > div').filter({has:page.locator('dt').filter({hasText:new RegExp('^'+label+'$')})}).locator('dd');
  const literal=async(label,value)=>{const cell=datum(label);await cell.waitFor({state:'visible'});requireFact((await cell.innerText()).trim()===value,'literal_review_mismatch');};
  await literal('Company',review.companyName);if(review.employeeCode!==null)await literal('Employee ID',review.employeeCode);await literal('Leave type',review.leaveTypeName);await literal('Your reason',expected.humanText.reason);await literal('Your employee remark',expected.humanText.employeeRemark);
  await literal('Date',new Intl.DateTimeFormat('en',{dateStyle:'full',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(review.date+'T12:00:00Z')));await literal('Requested duration','Full day');
  const n=value=>new Intl.NumberFormat('en',{maximumFractionDigits:20}).format(value);await literal('Days to deduct',n(review.deductionDays));
  if(review.availableBalance!==null)await literal('Estimated available days',n(review.availableBalance));if(review.estimatedAvailableAfter!==null)await literal('Estimated days after request',n(review.estimatedAvailableAfter));
  await literal('Approval route','Not yet determined');
  // ADR0131 requires the person to read the exact effect and CLICK Confirm. The mounted flow has
  // no extra checkbox; do not fabricate one or silently change the product contract for automation.
  stage='single_explicit_confirm';const receipt=completed(await responseFor(page,'confirm',()=>panel.getByRole('button',{name:'Submit this leave request',exact:true}).click()),actionId);
  await panel.getByRole('status').filter({hasText:'Leave request submitted'}).waitFor({state:'visible'});await panel.getByText('Your request was submitted. Approval is separate; check Leave for the current status.',{exact:true}).waitFor({state:'visible'});
  nativeCompleted(await verifyCanonical({phase:'submitted',expected,actionId,receipt}),expected,baseline,receipt,review.deductionDays);
  async function reopenAfterReload(phase){
   await page.reload({waitUntil:'domcontentloaded'});await panel.waitFor({state:'visible'});
   const index=await responseFor(page,'list',()=>panel.getByRole('button',{name:'Find my saved reviews',exact:true}).click());
   requireFact(keys(index,['kind','reviews'])&&index.kind==='review_index'&&Array.isArray(index.reviews)&&index.reviews.length<=25,'saved_index_missing');const position=index.reviews.findIndex(row=>row.actionId===actionId);
   requireFact(position>=0&&index.reviews.filter(row=>row.actionId===actionId).length===1&&index.reviews[position].state==='completed','saved_completed_identity_missing');
   const buttons=panel.getByRole('button',{name:/^Open saved review:/});requireFact(await buttons.count()===index.reviews.length,'saved_index_ui_mismatch');
   const reopened=completed(await responseFor(page,'reopen',()=>buttons.nth(position).click()),actionId);requireFact(Object.keys(receipt).every(key=>reopened[key]===receipt[key]),'completed_receipt_changed');
   await panel.getByRole('status').filter({hasText:'Leave request submitted'}).waitFor({state:'visible'});
   nativeCompleted(await verifyCanonical({phase,expected,actionId,receipt:reopened}),expected,baseline,receipt,review.deductionDays);
  }
  stage='reload_completed_reopen';await reopenAfterReload('reopened');stage='repeat_readonly_reopen';await reopenAfterReload('reopened_again');
  requireFact(!unexpected&&operations.filter(op=>op==='prepare').length===1&&operations.filter(op=>op==='confirm').length===1&&operations.filter(op=>op==='reopen').length===2&&!operations.includes('discard'),'unexpected_effect_request_count');
  return{journey:'english_own_leave_primary',checks:['real_current_own_selection','prepare_no_native_effect','literal_saved_review','single_explicit_confirm_native_refs','reload_same_completed_receipt','repeat_readonly_reopen_no_extra_effect'].map(id=>({id,passed:true})),coverage:'fictional_english_positive_ui_and_readonly_native_reconciliation_only',notCovered:['duplicate_confirm_transport_delivery','lost_or_ambiguous_responses','cross_scope_and_revocation','erasure_and_retention','other_module_actions','other_locales','mobile_accessibility','SMTP_and_provider_capability','production_authentication','combined_release_gate']};
 }catch{fail(stage);}finally{page.off('request',observe);}
}
