/** Browser-only, read-only Payroll readiness; use the already-authenticated isolated context. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

const english=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const adjustPath=id=>'/payroll/transactions/adjustments?batchId='+id;
const resumePath=id=>'/payroll/process?resume='+id;
const anomalyPath=id=>'/payroll/'+id+'/anomalies';
export const payrollReadinessSurfaces=['resume','anomalies','draft-adjustments'];

function ownedTarget(fixture,user){
 // Company 0 is processed by the loaded group-HR action, and 1 by the baseline calculation/publication.
 // Pick an existing untouched company-2 draft and that company's already-generated closed run.
 const companyIndex=2,target=fixture.tenants[user.tenant]?.companies[companyIndex];
 assert(target&&uuid.test(target.batchId)&&uuid.test(target.historicalBatchId)&&target.batchId!==target.historicalBatchId,'Payroll browser needs a separate live draft and closed historical run');
 assert(!fixture.users.some(actor=>actor.role==='groupHR'&&actor.batchId===target.batchId),'Payroll browser draft is in the mutation workload');
 const own=fixture.users.find(actor=>actor.tenant===user.tenant&&actor.company===companyIndex&&actor.role==='employee');
 const other=fixture.users.find(actor=>actor.tenant===user.tenant&&actor.company!==companyIndex&&actor.role==='employee');
 const foreign=fixture.users.find(actor=>actor.tenant!==user.tenant&&actor.role==='employee');
 assert(own&&other&&foreign,'Payroll browser needs distinct synthetic company and tenant identities');
 return{...target,own,other,foreign,companyLabel:`PERF Company ${user.tenant}-${companyIndex}`};
}

export async function exercisePayrollBrowser({base,page,user,fixture,report,save,phase,loadState,surface,timeout=90000}){
 assert(['groupHR','companyHR'].includes(user.role));
 assert(user.role!=='companyHR'||phase==='baseline','do not add negative boundary requests to the loaded window');
 assert(surface===undefined||payrollReadinessSurfaces.includes(surface),'unknown Payroll readiness surface');
 const target=ownedTarget(fixture,user),main=page.locator('main');
 const {process:processCopy,batch:batchCopy,transactions}=english.payroll,anomaly=english.anomaly;
 const data=report.browserPayrollReadiness??=[];
 const heading=title=>main.getByRole('heading',{name:title,level:1,exact:true});
 const batchForms=id=>main.locator('form').filter({has:page.locator('input[name="batchId"][value="'+id+'"]')});
 const action=(id,name)=>batchForms(id).getByRole('button',{name,exact:true});
 async function check(surface,path,verify){
  const start=performance.now(),loadAtStart=loadState?.();
  const remaining=()=>{const ms=Math.ceil(timeout-(performance.now()-start));assert(ms>0,'Payroll readiness exceeded the existing browser budget');return ms;};
  try{
   const response=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:remaining()});
   assert(response&&new URL(page.url()).origin===base&&!new URL(page.url()).pathname.startsWith('/login'),'Payroll browser lost its authenticated context');
   await verify(response.status(),remaining);
   const elapsedMs=performance.now()-start;remaining();
   data.push({phase,role:user.role,surface,elapsedMs,loadAtStart,loadAtReady:loadState?.(),status:response.status(),usable:user.role==='groupHR',scopeDenied:user.role==='companyHR',mutations:0});save();
  }catch(error){data.push({phase,role:user.role,surface,elapsedMs:performance.now()-start,loadAtStart,loadAtFailure:loadState?.(),usable:false,failed:true,errorType:error.name});save();throw error;}
 }
 if(user.role==='groupHR'){
  if(surface===undefined||surface==='resume')await check('resume',resumePath(target.batchId),async(status,remaining)=>{
   assert.equal(status,200);
   await heading(processCopy.title).waitFor({state:'visible',timeout:remaining()});
   await main.getByText(processCopy.resumeStep1Note,{exact:true}).waitFor({state:'visible',timeout:remaining()});
   await main.getByText(target.companyLabel,{exact:true}).waitFor({state:'visible',timeout:remaining()});
   await main.getByText(fixture.month,{exact:true}).waitFor({state:'visible',timeout:remaining()});
   // Continue is a hydrated wizard step, not a submit. Require the actual scoped employee data.
   await main.getByRole('button',{name:processCopy.continue,exact:true}).click({timeout:remaining()});
   const labels=main.locator('label').filter({has:page.locator('input[type="checkbox"]')});
   await labels.filter({hasText:target.own.name}).waitFor({state:'visible',timeout:remaining()});
   const scope=new Set(fixture.users.filter(actor=>actor.tenant===user.tenant&&actor.companyId===target.companyId).map(actor=>'PERF'+String(actor.index).padStart(4,'0')));
   const rendered=(await labels.allTextContents()).flatMap(text=>text.match(/PERF[0-9]{4}/g)??[]);
   assert(rendered.length>0&&rendered.every(code=>scope.has(code)),'Payroll wizard returned an employee outside the draft company');
   assert.equal(await labels.filter({hasText:target.other.name}).count(),0,'Payroll wizard exposed an employee from another company');
   assert.equal(await labels.filter({hasText:target.foreign.name}).count(),0,'Payroll wizard exposed an employee from another tenant');
  });
  if(surface===undefined||surface==='anomalies')await check('anomalies',anomalyPath(target.historicalBatchId),async(status,remaining)=>{
   assert.equal(status,200);
   await heading(anomaly.title).waitFor({state:'visible',timeout:remaining()});
   // The shared PageHeader prepends a visible arrow to the localized link label.
   const batchLink=main.locator('a[href="/payroll/'+target.historicalBatchId+'"]').filter({hasText:anomaly.backToBatch});
   await batchLink.waitFor({state:'visible',timeout:remaining()});
   // Some fixture versions already have a verdict; others offer the read-only check to the operator.
   const initial=action(target.historicalBatchId,anomaly.runNow);
   const verdict=main.getByText(anomaly.metricAutoClear,{exact:true});
   await initial.or(verdict).first().waitFor({state:'visible',timeout:remaining()});
  });
  if(surface===undefined||surface==='draft-adjustments')await check('draft-adjustments',adjustPath(target.batchId),async(status,remaining)=>{
   assert.equal(status,200);
   await heading(transactions.adjustments.title).waitFor({state:'visible',timeout:remaining()});
   const overtime=action(target.batchId,batchCopy.prefillOt),claims=action(target.batchId,batchCopy.prefillClaims);
   await overtime.waitFor({state:'visible',timeout:remaining()});
   await claims.waitFor({state:'visible',timeout:remaining()});
   assert(await overtime.isEnabled()&&await claims.isEnabled(),'draft adjustment controls are not ready');
  });
  return;
 }
 assert.notEqual(target.companyId,user.companyId,'Payroll boundary must target another company');
 await check('resume',resumePath(target.batchId),async(status,remaining)=>{
  assert.equal(status,200);
  await heading(processCopy.title).waitFor({state:'visible',timeout:remaining()});
  await main.getByText(processCopy.draftNotFoundOrNoAccess,{exact:true}).waitFor({state:'visible',timeout:remaining()});
  assert.equal(await main.getByText(processCopy.resumeStep1Note,{exact:true}).count(),0,'out-of-scope draft wizard is reachable');
 });
 await check('anomalies',anomalyPath(target.historicalBatchId),async(status,remaining)=>{
  // Next may stream a not-found page on a 200 response; require the rendered not-found state.
  assert([200,404].includes(status),'unexpected response for out-of-scope anomalies');
  await page.getByRole('heading',{name:'404',exact:true}).waitFor({state:'visible',timeout:remaining()});
  assert.equal(await heading(anomaly.title).count(),0,'out-of-scope anomaly details are reachable');
 });
 await check('draft-adjustments',adjustPath(target.batchId),async(status,remaining)=>{
  assert.equal(status,200);
  await heading(transactions.adjustments.title).waitFor({state:'visible',timeout:remaining()});
  // The existing picker can legitimately fall back to the actor's only owned draft.
  const chooser=main.getByText(transactions.draftPicker.title,{exact:true}).or(main.getByRole('heading',{name:transactions.draftPicker.noneTitle,exact:true}));
  await chooser.first().waitFor({state:'visible',timeout:remaining()});
  assert.equal(await batchForms(target.batchId).count(),0,'out-of-scope adjustment actions are reachable');
  assert.equal(await main.locator('a[href="'+adjustPath(target.batchId)+'"]').count(),0,'out-of-scope draft is listed by the picker');
  assert.equal(await main.getByText(target.companyLabel,{exact:true}).count(),0,'out-of-scope company is listed by the picker');
  const boundIds=await main.locator('form input[name="batchId"]').evaluateAll(inputs=>inputs.map(input=>input.value));
  assert(boundIds.every(id=>id===user.batchId),'draft adjustment fell back to a run outside the actor company');
 });
}
