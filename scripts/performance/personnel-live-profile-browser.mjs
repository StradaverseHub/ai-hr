/** One synthetic activated profile edit and restore in an existing built-browser context. */
import assert from 'node:assert/strict';

const localOrigin='https://localhost:3443', budgetMs=90_000;
const profile=person=>'/admin/personnel/'+person.employmentId;
const contact='section.contact.';
const field=(fields,name)=>{
 const matches=Object.keys(fields).filter(key=>key===name||key.endsWith('_'+name));
 assert.equal(matches.length,1,'Expected one captured Personnel action field: '+name);
 return matches[0];
};

async function actionTemplate(req){
 const wire=req.headers(),type=wire['content-type'];
 assert(type?.startsWith('multipart/form-data'),'Profile action transport is not FormData');
 const data=await new Request(req.url(),{method:'POST',headers:{'content-type':type},body:req.postDataBuffer()}).formData();
 const entries=[...data];
 assert(entries.every(([,value])=>typeof value==='string'),'Unexpected non-string Profile action field');
 const order=entries.map(([key])=>key);
 assert.equal(new Set(order).size,order.length,'Unexpected repeated Profile action field');
 const headers=Object.fromEntries(['accept','next-action','next-router-state-tree'].filter(key=>wire[key]).map(key=>[key,wire[key]]));
 const url=new URL(req.url());
 assert.equal(url.origin,localOrigin);
 return {path:url.pathname+url.search,fields:Object.fromEntries(entries),order,headers};
}

function refusedOutcome(content){
 const outcomes=[];
 for(const line of content.split('\n')){
  const match=/^[0-9a-f]+:(\{.*\})$/.exec(line);
  if(!match)continue;
  let value;
  try{value=JSON.parse(match[1]);}catch{continue;}
  if(value&&typeof value.ok==='boolean'&&Array.isArray(value.saved))outcomes.push(value);
 }
 assert.equal(outcomes.length,1,'Typed Profile tab action outcome was absent or ambiguous');
 const [outcome]=outcomes;
 assert.equal(outcome.ok,false,'A company HR action unexpectedly admitted an out-of-scope employee');
 assert.deepEqual(outcome.saved,[]);
 assert.equal(outcome.failedSection,'contact');
 assert(typeof outcome.error==='string'&&outcome.error.length>0,'Profile refusal had no public reason');
}

/** Call only from the existing isolated load fixture, with its signed-in companyHR page and
 * read-only owner oracle. No browser context, database write, provider or deployment is created here.
 * The forbidden case replays the actual action as the same company-scoped actor. */
export async function exerciseLivePersonnelProfile({page,user,fixture,db,request,report,save,phase}){
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
  const url=new URL(process.env[key]);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');assert.equal(url.pathname,'/ai_hr_dev');
 }
 assert.equal(user.role,'companyHR');
 assert.equal(fixture.users.length,500);
 const tenantId=fixture.tenants[user.tenant].tenantId;
 const owned=fixture.users.filter(person=>person.tenant===user.tenant&&person.companyId===user.companyId&&person.role==='employee').at(-1);
 const outside=fixture.users.filter(person=>person.tenant===user.tenant&&person.companyId!==user.companyId&&person.role==='employee').at(-1);
 assert(owned&&outside&&owned.personId!==outside.personId,'Missing synthetic distinct company witnesses');
 const roles=await db`select role,company_id from role_assignment where tenant_id=${tenantId}::uuid and app_user_id=${user.userId}::uuid`;
 assert.deepEqual(roles.filter(role=>role.role==='hr_admin'),[{role:'hr_admin',company_id:user.companyId}]);
 assert(!roles.some(role=>role.role==='super_admin'),'Fixture actor is unexpectedly group-wide');
 const person=async(subject)=>{
  const [row]=await db`select p.full_name,p.primary_email,p.home_phone,e.tenant_id,e.company_id,
   (select count(*)::int from employment jobs where jobs.tenant_id=e.tenant_id and jobs.person_id=p.id and jobs.voided_at is null) as employments,
   jsonb_build_object('phone',p.phone,'personalEmail',p.personal_email,'corrMobile',p.correspondence_mobile_phone,'corrHome',p.correspondence_home_phone,
    'perm1',p.permanent_address_line1,'perm2',p.permanent_address_line2,'perm3',p.permanent_address_line3,'permPost',p.permanent_postcode,
    'permCity',p.permanent_city,'permState',p.permanent_state,'permCountry',p.permanent_country,
    'corr1',p.correspondence_address_line1,'corr2',p.correspondence_address_line2,'corr3',p.correspondence_address_line3,'corrPost',p.correspondence_postcode,
    'corrCity',p.correspondence_city,'corrState',p.correspondence_state,'corrCountry',p.correspondence_country) as other_contact
   from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
   where e.id=${subject.employmentId}::uuid and p.id=${subject.personId}::uuid and e.voided_at is null and e.terminated_on is null`;
  assert(row,'Synthetic live profile subject missing');
  return row;
 };
 const initial=await person(owned),foreign=await person(outside);
 for(const [row,subject] of [[initial,owned],[foreign,outside]]){
  assert.equal(row.tenant_id,tenantId);assert.equal(row.company_id,subject.companyId);assert.equal(row.employments,1);
  assert.equal(row.full_name,subject.name);assert.equal(row.primary_email,'person'+subject.index+'@example.invalid');
  // This fixture begins blank, so a failed authority boundary cannot overwrite other contact values.
  assert.equal(row.home_phone,null);assert(Object.values(row.other_contact).every(value=>value===null));
 }
 const updates=async subject=>Array.from(await db`select id,actor_id,subject_employment_id,actor_type,(payload->'fields')?'homePhone' as phone_field
  from domain_event where tenant_id=${tenantId}::uuid and aggregate_type='person' and aggregate_id=${subject.personId}::uuid
   and event_type='person.updated' order by sequence`);
 const beforeAudit=await updates(owned),outsideAudit=await updates(outside);
 const marker='03-9000'+String(user.index).padStart(4,'0');
 const deniedMarker='03-9111'+String(user.index).padStart(4,'0');
 const timings=[],deadline=performance.now()+budgetMs;
 const remaining=()=>{const ms=Math.ceil(deadline-performance.now());assert(ms>0,'Live Personnel profile browser budget exceeded');return ms;};
 const time=(step,start,extra={})=>{timings.push({step,elapsedMs:performance.now()-start,...extra});};
 const bounded=async(task)=>{
  let timer;
  try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Live Personnel profile response timed out')),remaining());})]);}
  finally{clearTimeout(timer);}
 };
 const scope=page.locator('main [data-tab-save-scope="profile"]:visible');
 const phone=scope.locator('form[data-save-section="contact"] input#perm-home-phone[name="homePhone"]');
 const button=()=>scope.getByRole('button',{name:'Save Changes',exact:true});
 async function open(expected){
  const start=performance.now();
  const response=await page.goto(localOrigin+profile(owned)+'?tab=job',{waitUntil:'domcontentloaded',timeout:remaining()});
  assert.equal(response?.status(),200);
  await page.getByRole('heading',{level:1,name:owned.name,exact:true}).waitFor({timeout:remaining()});
  assert.equal(await page.locator('html').getAttribute('lang',{timeout:remaining()}),'en');
  const skip=page.getByRole('dialog').getByRole('button',{name:'Skip',exact:true});
  if(await skip.isVisible()){
   await skip.click({timeout:remaining()});
   await skip.waitFor({state:'hidden',timeout:remaining()});
  }
  // The client tab change proves hydration; the existing shell keeps the actual form and Save scope.
  await Promise.all([page.waitForURL(url=>url.pathname===profile(owned)&&url.searchParams.get('tab')==='profile',{timeout:remaining()}),
   page.getByRole('tab',{name:'Profile',exact:true}).click({timeout:remaining()})]);
  await phone.waitFor({timeout:remaining()});
  assert.equal(await phone.inputValue({timeout:remaining()}),expected??'');
  assert(await phone.isEditable({timeout:remaining()}),'Company HR cannot edit its authorized subject');
  assert(await button().isDisabled(),'Fresh Profile unexpectedly has unsaved edits');
  time('profile-open-to-editable',start);
 }
 async function update(value,step,expectedAction){
  const start=performance.now();
  await phone.fill(value??'',{timeout:remaining()});
  await scope.locator('[data-tab-save-count]').waitFor({timeout:remaining()});
  assert(await button().isEnabled(),'Profile contact edit did not activate Save');
  const [req]=await Promise.all([page.waitForRequest(candidate=>{
   const headers=candidate.headers(),url=new URL(candidate.url());
   return url.origin===localOrigin&&url.pathname===profile(owned)&&candidate.method()==='POST'&&Boolean(headers['next-action'])&&
    (!expectedAction||headers['next-action']===expectedAction);
  },{timeout:remaining()}),button().click({timeout:remaining()})]);
  const template=await actionTemplate(req);
  assert.equal(template.fields[field(template.fields,'sections')],'contact');
  assert.equal(template.fields[field(template.fields,'employmentId')],owned.employmentId);
  assert.equal(template.fields[field(template.fields,contact+'personId')],owned.personId);
  assert.equal(template.fields[field(template.fields,contact+'homePhone')],value??'');
  const response=await bounded(req.response());
  assert.equal(response?.status(),200);
  const headersByMs=performance.now()-start;
  await scope.locator('[data-tab-save-count]').waitFor({state:'hidden',timeout:remaining()});
  await button().waitFor({timeout:remaining()});
  assert(await button().isDisabled(),'Profile save did not become usable again');
  assert.equal(await scope.locator('[role="alert"]').count(),0,'Profile Save returned a public error');
  assert.deepEqual(await person(owned),{...initial,home_phone:value});
  time(step,start,{headersByMs,persisted:true});
  return template;
 }
 let template,started=false,restored=false;
 try{
  await open(initial.home_phone);
  started=true;
  template=await update(marker,'edit-save-to-usable');
  await open(marker); // fresh server-rendered value, independent of the form's optimistic state
  await update(initial.home_phone,'restore-save-to-usable',template.headers['next-action']);
  restored=true;
 }finally{
  // If the page changed after a successful commit, restore only the exact synthetic field through
  // the same app route. Never fall back to an owner SQL mutation.
  if(started&&!restored){
   const current=await person(owned);
   if(current.home_phone===marker){
    assert.deepEqual(current,{...initial,home_phone:marker});
    await open(marker);
    await update(initial.home_phone,'cleanup-restore',template?.headers['next-action']);
   }
   assert.deepEqual(await person(owned),initial);
  }
 }
 const editedAudit=await updates(owned);
 assert.deepEqual(editedAudit.slice(0,beforeAudit.length),beforeAudit);
 assert.equal(editedAudit.length,beforeAudit.length+2);
 for(const event of editedAudit.slice(beforeAudit.length))assert.deepEqual(
  [event.actor_type,event.actor_id,event.subject_employment_id,event.phone_field],['user',user.userId,owned.employmentId,true]);
 const forged={...template.fields};
 const replace=(name,value)=>{forged[field(forged,name)]=value;};
 replace('employmentId',outside.employmentId);
 replace(contact+'employmentId',outside.employmentId);
 replace(contact+'personId',outside.personId);
 replace(contact+'fullName',foreign.full_name);
 replace(contact+'primaryEmail',foreign.primary_email);
 replace(contact+'homePhone',deniedMarker);
 const denyStart=performance.now();
 const refusal=await bounded(request(user,template.path,forged,200,false,template.headers,template.order));
 refusedOutcome(refusal.content);
 assert.deepEqual(await person(outside),foreign);
 assert.deepEqual(await updates(outside),outsideAudit);
 assert.deepEqual(await person(owned),initial);
 assert.deepEqual(await updates(owned),editedAudit);
 time('foreign-company-write-refused',denyStart,{typedDenial:true,unchanged:true});
 (report.personnelLiveProfileEdits??=[]).push({phase,role:user.role,field:'homePhone',authorizedEdit:true,restored:true,
  persistedAfterFreshOpen:true,actorAuditVerified:true,denialVerified:true,timings});
 save();
}
