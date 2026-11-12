/** Authored UNRUN protocol fixtures only. Fake Page is not browser, native DB or release evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {discardedReceipt,assertRetirementNativeFacts,OWN_LEAVE_RETIREMENT_CHECKS,runAssistantOwnLeaveRetirementEnglishExperience} from './assistant-own-leave-retirement-experience.mjs';
const userId='00000000-0000-4000-8000-000000000001',actionId='00000000-0000-4000-8000-000000000002',employmentId='00000000-0000-4000-8000-000000000003',leaveTypeId='00000000-0000-4000-8000-000000000004';
const expected={userId,employmentId,leaveTypeId,date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+86400000)),humanText:{reason:'Fictional retirement reason',employeeRemark:'Fictional retirement remark'}};
const counts={totalTenantRequests:1,totalTenantSubmissionEvents:1,matchingRequests:0,matchingSubmissionEvents:0,totalTenantModelRuns:0};
const receipt={actionId,contractVersion:1,state:'discarded'};
const facts=state=>({currentActorUserId:userId,counts:{...counts},request:null,event:null,custody:state?{state,bodyCount:state==='awaiting_confirmation'?1:0,digestsPresent:state==='awaiting_confirmation',pairedRefsPresent:false}:null});
test('retirement facts require actual unchanged counts and physical encrypted-row retirement, never terminal labels alone',()=>{
 assert.deepEqual(assertRetirementNativeFacts(facts(null),expected,null,null),counts);
 for(const state of ['awaiting_confirmation','discarded'])assert.deepEqual(assertRetirementNativeFacts(facts(state),expected,counts,state),counts);
 for(const patch of [{currentActorUserId:'foreign'},{counts:{...counts,totalTenantRequests:2}},{counts:{...counts,totalTenantSubmissionEvents:2}},{counts:{...counts,totalTenantModelRuns:1}},{request:{id:actionId}},{event:{id:actionId}},{custody:{...facts('discarded').custody,bodyCount:1}},{custody:{...facts('discarded').custody,digestsPresent:true}},{custody:{...facts('discarded').custody,pairedRefsPresent:true}}])assert.throws(()=>assertRetirementNativeFacts({...facts('discarded'),...patch},expected,counts,'discarded'));
 assert.throws(()=>assertRetirementNativeFacts(facts('expired'),expected,counts,'discarded'));
});
test('discarded receipt has no canonical refs, body or substituted action and is not expiry proof',()=>{
 assert.deepEqual(discardedReceipt({kind:'retired',receipt},actionId),receipt);
 for(const altered of [{...receipt,state:'expired'},{...receipt,state:'completed'},{...receipt,leaveRequestId:employmentId},{...receipt,actionId:employmentId},{...receipt,contractVersion:2},{...receipt,humanText:expected.humanText}])assert.throws(()=>discardedReceipt({kind:'retired',receipt:altered},actionId));
});
function fakePage(){
 let pending,phase='draft',responses=[],handlers=new Set();
 const page={url:()=> 'http://127.0.0.1:3117/assistant',on:(_name,handler)=>handlers.add(handler),off:(_name,handler)=>handlers.delete(handler),goto:async()=>{},reload:async()=>{phase='draft';},waitForResponse:predicate=>new Promise(resolve=>{pending=response=>{assert(predicate(response));resolve(response);};})};
 const review={actionId,contractVersion:1,date:expected.date,durationType:'full_day',deductionDays:1,humanText:expected.humanText,expiresAt:new Date(Date.now()+600000).toISOString(),companyName:'Fictional company',employeeCode:'FICT',leaveTypeName:'Annual',availableBalance:5,estimatedAvailableAfter:4,holidayWarnings:[],approvalRouting:'unknown'};
 const emit=op=>{const packet=op==='prepare'?{kind:'prepared',review}:op==='list'?{kind:'review_index',reviews:[{actionId,state:'discarded'}]}:{kind:'retired',receipt};const req={url:()=>new URL('/api/assistant/own-leave',page.url()).href,method:()=> 'POST',postDataJSON:()=>({operation:op})};for(const h of handlers)h(req);responses.push(op);const response={url:()=>new URL('/api/assistant/own-leave',page.url()).href,request:()=>req,ok:()=>true,headers:()=>({'content-type':'application/json'}),text:async()=>JSON.stringify(packet)};phase=op==='prepare'?'review':op==='discard'||op==='reopen'?'retired':phase;assert(pending);pending(response);pending=null;};
 const locator=(role,opts={})=>({waitFor:async()=>{},getAttribute:async()=> 'en',selectOption:async()=>{},fill:async()=>{},getByLabel:label=>locator('label',{name:label}),getByRole:(r,o)=>locator(r,o),filter:()=>locator(role,opts),count:async()=>opts.name==='Submit this leave request'?(phase==='review'?1:0):1,nth:()=>locator(role,opts),click:async()=>{const name=String(opts.name);emit(name==='Prepare leave review'?'prepare':name==='Discard saved review'?'discard':name==='Find my saved reviews'?'list':'reopen');}});
 page.locator=()=>locator('html');page.getByRole=(r,o)=>locator(r,o);
 return{page,review,responses};
}
test('fake Page protocol traverses real-control contract in fixed order; it does not manufacture runtime evidence',async()=>{
 const {page,review,responses}=fakePage(),phases=[];
 const fixture={state:'native_prerequisites_prepared_not_experienced',limits:{uiTargetEffects:'not_executed'},actors:{self:{userId,employmentId}},workforce:{leave:{annualTypeId:leaveTypeId,self:{date:expected.date,deductionDays:1,humanText:expected.humanText}}},expectedNative:{baselineLeaveRequests:1,baselineSubmittedEvents:1}};
 const result=await runAssistantOwnLeaveRetirementEnglishExperience({page,fixture,verifyCanonical:async p=>{phases.push(p.phase);assert.deepEqual(p.expected,expected);return{...facts(p.phase==='baseline'?null:p.phase==='prepared'?'awaiting_confirmation':'discarded'),...(p.phase==='prepared'?{reviewProjection:review}:{})};}});
 assert.deepEqual(phases,['baseline','prepared','discarded','reopened','reopened_again']);assert.deepEqual(responses,['prepare','discard','list','reopen','list','reopen']);assert.equal(result.journey,'english_own_leave_retirement');assert.deepEqual(result.checks.map(c=>c.id),OWN_LEAVE_RETIREMENT_CHECKS);assert(result.notCovered.includes('expiry_cleanup'));
});
test('real journey source has no HTTP/session/SQL injection or forced expiry path',()=>{
 const source=readFileSync(new URL('./assistant-own-leave-retirement-experience.mjs',import.meta.url),'utf8');
 for(const prohibited of ['page.route(','context.route(','page.request.','addCookies(','fetch(','page.evaluate(','setSystemTime(','setCookie(','verifyCanonical({phase:\'expired\''])assert(!source.includes(prohibited));
 assert(source.includes("name:'Discard saved review',exact:true"));assert(source.includes("name:/^Open saved review:/"));assert(source.includes("same(ops,['prepare','discard','list','reopen','list','reopen'])"));
});
