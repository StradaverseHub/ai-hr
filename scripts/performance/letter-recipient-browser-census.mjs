import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

const timeout=15000;

async function acknowledge(page,main,origin,path){
 const observation={status:'failed',step:'checkbox',posts:0,postStatuses:[],samePageAtStart:page.url()===origin+path};
 const isSave=request=>request.method()==='POST'&&new URL(request.url()).pathname===path;
 const posted=request=>{if(isSave(request))observation.posts++;};
 const responded=response=>{if(isSave(response.request()))observation.postStatuses.push(response.status());};
 page.on('request',posted);
 page.on('response',responded);
 try{
  await main.locator('input[name="confirm"]').check({timeout});
  observation.step='submit';
  const started=performance.now();
  await main.getByRole('button',{name:'Acknowledge',exact:true}).click({timeout});
  observation.step='confirmation';
  await main.getByText('Your confirmation has been recorded.',{exact:true}).waitFor({state:'visible',timeout});
  observation.elapsedMs=Math.round(performance.now()-started);
  observation.status='observed';
  delete observation.step;
 }catch(error){
  observation.failure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';
 }finally{
  page.off('request',posted);
  page.off('response',responded);
 }
 const query=new URL(page.url()).searchParams;
 observation.result=query.has('error')?'refused':query.has('notice')?'notice':'same-form';
 return observation;
}

export async function measureLetterRecipients({db,fixture,origin,compiledPages,signedInContext,report,save}){
 const seed=fixture.letterRecipientRecords,templateName=fixture.tenants[0].letterDraft?.name;
 assert(seed&&templateName,'Missing persisted fictional issuance and submission');
 const actor=index=>fixture.users.find(user=>user.index===index);
 const reviewer=actor(seed.reviewerIndex),recipient=actor(seed.recipientIndex),other=actor(seed.otherEmployeeIndex);
 assert(reviewer?.role==='companyHR'&&recipient?.role==='employee'&&other?.role==='employee');
 const [artifact]=await db`
  select a.content_hash,r.state,r.employment_id
  from letter_artifact a join letter_record r on r.id=a.letter_id and r.tenant_id=a.tenant_id
  where a.id=${seed.issued.artifactId}::uuid and r.id=${seed.issued.id}::uuid and r.tenant_id=${recipient.tenantId}::uuid`;
 assert(artifact?.state==='issued'&&artifact.employment_id===recipient.employmentId&&/^[a-f0-9]{64}$/.test(artifact.content_hash));
 const [pending]=await db`
  select state,reference from letter_record
  where id=${seed.pending.id}::uuid and tenant_id=${reviewer.tenantId}::uuid`;
 assert.deepEqual(pending,{state:'submitted',reference:seed.pending.reference});
 const cases=[
  {actor:reviewer,template:'/letters/approval/[letterId]',path:'/letters/approval/'+seed.pending.id,reference:seed.pending.reference,
   witness:main=>main.getByText(templateName,{exact:false}).first()},
  {actor:reviewer,template:'/letters/register/[letterId]',path:'/letters/register/'+seed.issued.id,reference:seed.issued.reference,
   witness:main=>main.getByText(templateName,{exact:false}).first()},
  {actor:recipient,template:'/me/letters/[letterId]',path:'/me/letters/'+seed.issued.id,reference:seed.issued.reference,
   witness:main=>main.getByRole('button',{name:'Download PDF',exact:true}),owns:true},
 ];
 assert(cases.every(entry=>compiledPages.has(entry.template)));
 report.fixtureRecordVisits=[];
 for(const entry of cases){
  const context=await signedInContext(entry.actor);
  try{
   const page=await context.newPage();
   const main=page.locator('main:visible').first();
   for(const visit of ['first','repeat']){
    const row={template:entry.template,visit,role:entry.actor.role,status:'failed',step:'document'};
    report.fixtureRecordVisits.push(row);
    const started=performance.now();
    try{
     const response=await page.goto(origin+entry.path,{waitUntil:'domcontentloaded',timeout});
     assert.equal(response?.status(),200);
     assert.equal(page.url(),origin+entry.path);
     row.step='usable-content';
     await main.getByRole('heading',{name:entry.reference,level:1,exact:true}).waitFor({state:'visible',timeout});
     await entry.witness(main).waitFor({state:'visible',timeout});
     row.readyMs=Math.round(performance.now()-started);
     row.status='observed';
     delete row.step;
    }catch(error){
     row.failure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';
    }finally{save();}
   }
   if(!entry.owns || !report.fixtureRecordVisits.slice(-2).every(row=>row.status==='observed'))continue;
   const actions={status:'failed',step:'download'};
   report.letterRecipientActions=actions;
   const trace=actions.downloadProtocol={requests:[],responses:[]};
   const requestHeaders=[];
   const isDocumentRequest=request=>{
    const target=new URL(request.url());
    return target.origin===origin&&target.pathname===entry.path+'/document';
   };
   const recordRequest=request=>{
    if(!isDocumentRequest(request)||trace.requests.length>=4)return;
    const row={method:request.method(),navigation:request.isNavigationRequest()};
    trace.requests.push(row);
    requestHeaders.push(request.allHeaders().then(headers=>{
     row.origin=headers.origin===origin?'same':headers.origin==='null'?'opaque':headers.origin?'other':'absent';
     row.site=['same-origin','same-site','cross-site','none'].includes(headers['sec-fetch-site'])
      ?headers['sec-fetch-site']:'absent';
     row.mode=['navigate','cors','no-cors','same-origin'].includes(headers['sec-fetch-mode'])
      ?headers['sec-fetch-mode']:'absent';
     row.destination=headers['sec-fetch-dest']==='document'?'document':'other';
    }).catch(()=>{row.headersUnavailable=true;}));
   };
   const recordResponse=response=>{
    if(isDocumentRequest(response.request())&&trace.responses.length<4){
     trace.responses.push({method:response.request().method(),status:response.status()});
    }
   };
   page.on('request',recordRequest);
   page.on('response',recordResponse);
   try{
    const downloadStart=performance.now();
    const [download]=await Promise.all([
     page.waitForEvent('download',{timeout}),
     main.getByRole('button',{name:'Download PDF',exact:true}).click({timeout}),
    ]);
    const bytes=await readFile(await download.path());
    assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.content_hash);
    actions.downloadMs=Math.round(performance.now()-downloadStart);
    actions.downloadedArtifactVerified=true;
    actions.step='acknowledgement';
    const recipientFacts=async()=>Array.from(await db`
     select kind,actor_id,content_hash from letter_recipient_event
     where tenant_id=${recipient.tenantId}::uuid and letter_id=${seed.issued.id}::uuid
       and artifact_id=${seed.issued.artifactId}::uuid order by kind`);
    actions.afterDownload=await acknowledge(page,main,origin,entry.path);
    const firstFacts=await recipientFacts();
    actions.afterDownload.persisted=firstFacts.some(row=>row.kind==='acknowledged');
    if(actions.afterDownload.status!=='observed'&&!actions.afterDownload.persisted){
     const refreshed=await page.goto(origin+entry.path,{waitUntil:'domcontentloaded',timeout});
     assert.equal(refreshed?.status(),200);
     actions.afterReload=await acknowledge(page,main,origin,entry.path);
     actions.afterReload.persisted=(await recipientFacts()).some(row=>row.kind==='acknowledged');
    }
    assert.equal(actions.afterDownload.status,'observed','The direct post-download acknowledgement did not complete');
    assert.deepEqual(await recipientFacts(),['acknowledged','viewed'].map(kind=>({
     kind,actor_id:recipient.userId,content_hash:artifact.content_hash,
    })));
    actions.acknowledgementMs=actions.afterDownload.elapsedMs;
    actions.persisted=true;
    actions.status='observed';
    delete actions.step;
   }catch(error){
    actions.failure=error.name==='TimeoutError'?'timeout':error.code==='ERR_ASSERTION'?'assertion':'browser';
   }finally{
    page.off('request',recordRequest);
    page.off('response',recordResponse);
    await Promise.all(requestHeaders);
    save();
   }
  }finally{await context.close();}
 }
 const deniedContext=await signedInContext(other);
 try{
  const page=await deniedContext.newPage();
  const reply=await page.goto(origin+'/me/letters/'+seed.issued.id,{waitUntil:'domcontentloaded',timeout});
  assert(reply&&[200,404].includes(reply.status()));
  const body=await reply.text();
  assert(reply.status()===404||/NEXT_HTTP_ERROR_FALLBACK;404|<h1[^>]*>\s*404(?:\s|<)/.test(body));
  assert(!body.includes(seed.issued.reference)&&!body.includes(artifact.content_hash));
  report.letterRecipientScopeDenied=true;
  save();
 }finally{await deniedContext.close();}
 assert(report.fixtureRecordVisits.every(row=>row.status==='observed'),'A populated Letters route failed to render');
 assert.equal(report.letterRecipientActions?.status,'observed','The recipient download or acknowledgement did not complete');
 report.complete=true;
 save();
}
