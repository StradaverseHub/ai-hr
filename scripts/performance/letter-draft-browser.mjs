/** Real draft actions and protected routes on the isolated fictional browser fixture. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

const {letters}=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
const timeout=90000;
const dateInput='input[name="custom:effectiveDate:value"]';
const batchRoute=/^\/letters\/generate\/([0-9a-f-]{36})$/i;

export async function exerciseLetterDraft({base,context,visit,fixture,db,report,save}){
 const tenant=fixture.tenants[0],seed=tenant.letterDraft;
 assert(seed,'E-Letter preflight requires a fictional approved template and disabled notifications');
 const author=fixture.users.find(user=>user.index===seed.authorIndex&&user.tenant===0&&user.companyId===seed.companyId&&user.role==='companyHR');
 const recipient=fixture.users.find(user=>user.tenant===0&&user.companyId===seed.companyId&&user.role==='employee');
 const otherCompany=fixture.users.find(user=>user.tenant===0&&user.companyId!==seed.companyId&&user.role==='companyHR');
 const otherTenant=fixture.users.find(user=>user.tenant!==0&&user.role==='companyHR');
 assert(author&&recipient&&otherCompany&&otherTenant,'E-Letter preflight requires four distinct fictional principals');
 const code='PERF'+String(recipient.index).padStart(4,'0');
 const label=recipient.name+' · '+code;
 const pickerPath='/letters/templates/options?'+new URLSearchParams({kind:'employee',companyId:seed.companyId,q:code});
 const formCopy=letters.generate.form,picker=letters.templates.picker;
 const initialDate=fixture.today;
 const editedDate=new Date(Date.parse(initialDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 const reason='Fictional draft withdrawn before approval';
 const evidence={status:'running',actions:[],scope:[]};
 report.letterDraftBrowser=evidence;
 save();

 const authorContext=await context(author);
 try{
  const page=await authorContext.newPage(),main=page.locator('main');
  const newPath='/letters/generate/new?versionId='+seed.versionId;
  const toursBefore=report.onboardingTourDismissals??0;
  await visit(page,author,newPath);
  // This author has a fresh browser and has not dismissed the welcome tour.
  // The client can mount its blocking overlay after the shared visit sees the heading.
  if((report.onboardingTourDismissals??0)===toursBefore){
   const tour=page.getByRole('dialog',{name:'Product tour',exact:true});
   const skip=tour.getByRole('button',{name:'Skip',exact:true});
   await skip.click({timeout});
   await tour.waitFor({state:'hidden',timeout});
   report.onboardingTourDismissals=toursBefore+1;
   save();
  }
  await main.getByRole('heading',{name:formCopy.create,exact:true}).waitFor({state:'visible',timeout});
  await main.getByRole('textbox',{name:picker.search,exact:true}).fill(code);
  const [choices]=await Promise.all([
   page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/letters/templates/options'&&new URL(response.url()).searchParams.get('q')===code,{timeout}),
   main.getByRole('button',{name:picker.find,exact:true}).click({timeout}),
  ]);
  assert.equal(choices.status(),200);
  assert.deepEqual(await choices.json(),{rows:[{id:recipient.employmentId,label}],nextCursor:null});
  await main.getByRole('button',{name:picker.choose+': '+label,exact:true}).click({timeout});
  await main.locator(dateInput).fill(initialDate);
  const operationKey=await main.locator('input[name="operationKey"]').inputValue();

  async function submit(action,notice,button,expectedPath){
   evidence.currentAction=action;
   save();
   const start=performance.now();
   await Promise.all([
    page.waitForURL(url=>url.origin===base&&batchRoute.test(url.pathname)&&(!expectedPath||url.pathname===expectedPath)&&url.searchParams.get('notice')===notice,{timeout}),
    button.click({timeout}),
   ]);
   await main.getByRole('heading',{name:seed.name,exact:true}).waitFor({state:'visible',timeout});
   evidence.actions.push({action,usableMs:performance.now()-start});
   save();
   return new URL(page.url()).pathname;
  }

  const batchPath=await submit('create','created',main.getByRole('button',{name:formCopy.create,exact:true}));
  const batchId=batchRoute.exec(batchPath)[1];
  const [batch]=await db`select tenant_id,company_id,template_version_id,created_by,operation_key,selection from letter_generation_batch where id=${batchId}::uuid`;
  assert.deepEqual({...batch},{tenant_id:tenant.tenantId,company_id:seed.companyId,template_version_id:seed.versionId,created_by:author.userId,operation_key:operationKey,
   selection:{employmentIds:[recipient.employmentId],customValues:{[recipient.employmentId]:{effectiveDate:{kind:'date',value:initialDate}}},sourceAsOfDate:initialDate}});

  async function stored(){
   const records=await db`select id,tenant_id,company_id,employment_id,reference,created_by,state,lock_version,current_revision_id,submitted_at,issued_at from letter_record where batch_id=${batchId}::uuid`;
   assert.equal(records.length,1);
   const record=records[0];
   assert.equal(record.tenant_id,tenant.tenantId);
   assert.equal(record.company_id,seed.companyId);
   assert.equal(record.employment_id,recipient.employmentId);
   assert.equal(record.created_by,author.userId);
   assert.equal(record.submitted_at,null);
   assert.equal(record.issued_at,null);
   const revisions=await db`select id,ordinal,editable_values,created_by,content_hash from letter_revision where letter_id=${record.id}::uuid order by ordinal`;
   return {record,revisions};
  }
  function expectRevision(revision,ordinal,date){
   assert.equal(revision.ordinal,ordinal);
   assert.equal(revision.created_by,author.userId);
   assert.deepEqual(revision.editable_values,{effectiveDate:{kind:'date',value:date}});
   assert.match(revision.content_hash,/^[0-9a-f]{64}$/i);
  }
  const created=await stored();
  assert.equal(created.record.state,'draft');
  assert.equal(created.record.lock_version,2);
  assert.equal(created.revisions.length,1);
  expectRevision(created.revisions[0],1,initialDate);
  assert.equal(created.record.current_revision_id,created.revisions[0].id);
  await main.getByRole('heading',{name:created.record.reference,exact:true}).waitFor({state:'visible',timeout});

  const forms=action=>main.locator('form').filter({has:page.locator('input[name="action"][value="'+action+'"]')});
  await main.locator('summary').filter({hasText:letters.generate.page.correct}).click({timeout});
  const edit=forms('refresh');
  assert.equal(await edit.locator(dateInput).inputValue(),initialDate);
  await edit.locator(dateInput).fill(editedDate);
  await submit('edit','refresh',edit.locator('button[type="submit"]'),batchPath);
  const edited=await stored();
  assert.equal(edited.record.state,'draft');
  assert.equal(edited.record.lock_version,3);
  assert.equal(edited.revisions.length,2);
  assert.deepEqual(edited.revisions[0],created.revisions[0]);
  expectRevision(edited.revisions[1],2,editedDate);
  assert.equal(edited.record.current_revision_id,edited.revisions[1].id);
  assert.notEqual(edited.revisions[1].content_hash,created.revisions[0].content_hash);

  for(const [scope,actor] of [['same-tenant-other-company',otherCompany],['other-tenant',otherTenant],['unissued-recipient',recipient]]){
   const deniedContext=await context(actor);
   try{
    if(actor.role==='companyHR'){
     const allowedQuery=new URLSearchParams({kind:'employee',companyId:actor.companyId,q:'PERF'+String(actor.index).padStart(4,'0')});
     const allowedPicker=await deniedContext.request.get(base+'/letters/templates/options?'+allowedQuery,{timeout,maxRedirects:0});
     assert.equal(allowedPicker.status(),200);
     assert.deepEqual((await allowedPicker.json()).rows.map(row=>row.id),[actor.employmentId]);
    }
    const deniedPicker=await deniedContext.request.get(base+pickerPath,{timeout,maxRedirects:0});
    assert.equal(deniedPicker.status(),403);
    assert.deepEqual(await deniedPicker.json(),{error:'permission'});
    const denied=await deniedContext.request.get(base+batchPath,{timeout,maxRedirects:0});
    assert([200,404].includes(denied.status()),'E-Letter draft scope refusal did not return a not-found page');
    const html=await denied.text();
    assert(denied.status()===404||/NEXT_HTTP_ERROR_FALLBACK;404|<h1[^>]*>\s*404(?:\s|<)/.test(html),'E-Letter streamed scope refusal is missing');
    assert(!html.includes(created.record.reference)&&!html.includes(seed.name),'E-Letter draft data crossed a scope boundary');
    evidence.scope.push({scope,pickerDenied:true,draftDenied:true});
    save();
   }finally{await deniedContext.close();}
  }


  await main.locator('summary').filter({hasText:letters.generate.page.remove}).click({timeout});
  const withdrawal=forms('withdraw');
  await withdrawal.locator('textarea[name="reason"]').fill(reason);
  await submit('withdraw','withdraw',withdrawal.locator('button[type="submit"]'),batchPath);
  await main.getByText(letters.generate.page.withdrawn,{exact:true}).waitFor({state:'visible',timeout});
  assert.equal(await forms('refresh').count(),0);
  assert.equal(await forms('withdraw').count(),0);


  const final=await stored();
  assert.equal(final.record.state,'withdrawn');
  assert.equal(final.record.lock_version,4);
  assert.equal(final.record.current_revision_id,edited.record.current_revision_id);
  assert.deepEqual(final.revisions,edited.revisions);
  const id=final.record.id;
  const events=await db`select event_type,actor_id,payload from domain_event where tenant_id=${tenant.tenantId}::uuid and aggregate_id=${id}::uuid order by sequence`;
  assert.deepEqual(events.map(event=>[event.event_type,event.actor_id]),[['letter.revision.created',author.userId],['letter.revision.created',author.userId],['letter.withdrawn',author.userId]]);
  assert.deepEqual(events[2].payload,{reason,revisionId:edited.record.current_revision_id});
  const [effects]=await db`select (select count(*)::int from letter_artifact where letter_id=${id}::uuid) as artifacts,
   (select count(*)::int from letter_job where letter_id=${id}::uuid) as jobs,
   (select count(*)::int from letter_approval_decision where letter_id=${id}::uuid) as approvals`;
  assert.deepEqual(effects,{artifacts:0,jobs:0,approvals:0});
  Object.assign(evidence,{status:'passed',retainedRevisions:2,withdrawalEvents:1,artifacts:0,jobs:0});
  save();
 }catch(error){
  evidence.status='failed';
  evidence.errorType=error.name;
  save();
  throw error;
 }finally{await authorContext.close();}
}
