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
   try {
    await measure('save',async()=>{
     await form.getByRole('button',{name:'Save Event',exact:true}).click({timeout});
     evidence.steps.save.submitted=true;
     save();
     await page.waitForURL(url=>url.pathname===path&&url.searchParams.get('tab')==='careerMovement',{timeout});
     evidence.steps.save.returnedToHistory=true;
     save();
     await history.getByRole('cell',{name:'Secondment',exact:true}).waitFor({state:'visible',timeout});
    });
   } finally {
    // Record persistence even if the page failed to return or show the row. A database observation
    // failure must not replace the original browser failure or turn it into a passing journey.
    try {
     const rows=await db`select actor_id from domain_event where tenant_id=${fixture.tenants[actor.tenant].tenantId}::uuid
       and subject_employment_id=${subject.employmentId}::uuid and event_type='employment.movement.recorded'
       and payload->>'type'='secondment' and payload->>'remarks'=${marker}`;
     evidence.auditObservation={rows:rows.length,expectedActor:rows.length===1&&rows[0].actor_id===actor.userId};
    } catch {
     evidence.auditObservation={unavailable:true};
    }
    save();
   }
   assert.equal(evidence.auditObservation.expectedActor,true,'Movement save did not produce one audited event for the expected actor');
   evidence.auditVerified=true;
   save();
  }
 }finally{
  await page.removeLocatorHandler(tour);
 }
}
