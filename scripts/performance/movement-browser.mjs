import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

const timeout=90000;

export async function exerciseMovement({base,page,actor,subject,fixture,db,report,save,phase,recordEvent,loadState}){
 const path='/admin/personnel/'+subject.employmentId;
 const history=page.locator('#section-assignment-history');
 const tour=page.getByRole('dialog',{name:'Product tour',exact:true});
 const evidence={role:actor.role,phase,steps:{}};
 (report.browserMovementJourneys??=[]).push(evidence);
 await page.addLocatorHandler(tour,async()=>{
  await tour.getByRole('button',{name:'Skip',exact:true}).click({timeout});
  report.onboardingTourDismissals=(report.onboardingTourDismissals??0)+1;
 });
 async function measure(step,run){
  const started=performance.now();
  const load=loadState?.();
  evidence.steps[step]={...(load?{startedWith:load}:{}),status:'started'};
  save();
  await run();
  Object.assign(evidence.steps[step],{elapsedMs:performance.now()-started,status:'passed'});
  save();
 }
 try{
  const newEvent=history.getByRole('link',{name:'New Event',exact:true});
  await measure('history',async()=>{
   const response=await page.goto(base+path+'?tab=careerMovement',{waitUntil:'domcontentloaded',timeout});
   assert.equal(response?.status(),200,'Movement history navigation failed');
   await history.getByRole('cell',{name:'Hired',exact:true}).waitFor({state:'visible',timeout});
   await newEvent.waitFor({state:'visible',timeout});
  });
  const form=page.locator('#section-movement-new-event form');
  await measure('newEvent',async()=>{
   await newEvent.click({timeout});
   await page.waitForURL(url=>url.pathname===path+'/movement/new',{timeout});
   await form.locator('select').first().waitFor({state:'visible',timeout});
  });
  if(recordEvent){
   const marker='Fictional performance Movement save '+phase;
   await form.locator('select').first().selectOption('secondment',{timeout});
   await form.getByRole('textbox',{name:'Remarks',exact:true}).fill(marker,{timeout});
   async function observeAudit(){
    try {
     const rows=await db`select id, actor_id from domain_event where tenant_id=${fixture.tenants[actor.tenant].tenantId}::uuid
       and subject_employment_id=${subject.employmentId}::uuid and event_type='employment.movement.recorded'
       and payload->>'type'='secondment' and payload->>'remarks'=${marker}`;
     evidence.auditObservation={rows:rows.length,expectedActor:rows.length===1&&rows[0].actor_id===actor.userId};
     return rows.length===1 ? rows[0].id : null;
    } catch {
     evidence.auditObservation={unavailable:true};
     return null;
    } finally {
     save();
    }
   }
   try {
    await measure('save',async()=>{
     await form.getByRole('button',{name:'Save Event',exact:true}).click({timeout});
     evidence.steps.save.submitted=true;
     save();
     await page.waitForURL(url=>url.pathname===path&&url.searchParams.get('tab')==='careerMovement',{timeout});
     evidence.steps.save.returnedToHistory=true;
     save();
     const eventId=await observeAudit();
     assert(eventId&&evidence.auditObservation.expectedActor,'Movement save did not produce one audited event for the expected actor');
     // Identify the actual saved event, even when a status badge adds text to its cell.
     const savedRow=history.locator(`tr[data-movement-id="${eventId}"]`);
     await savedRow.getByText('Secondment',{exact:true}).waitFor({state:'visible',timeout});
    });
   } finally {
    // Capture persistence independently when the click or navigation did not finish.
    if(!evidence.auditObservation)await observeAudit();
   }
   evidence.auditVerified=true;
   save();
  }
 }finally{
  await page.removeLocatorHandler(tour);
 }
}
