import assert from 'node:assert/strict';

const landingTemplate='/invite/[token]';
const activationTemplate=landingTemplate+'/activate';
const timeout=15000;

export async function measureInvitationRecords({db,fixture,origin,compiledPages,signedInContext,report,save}){
 assert(compiledPages.has(landingTemplate)&&compiledPages.has(activationTemplate));
 const {invitationId,token}=fixture.invitationRecord;
 const employee=fixture.users[4];
 const landing='/invite/'+token;
 const activation=landing+'/activate';
 const observations=[];
 report.fixtureRecordCensus={plannedTemplates:2,plannedJourneys:2,observations};
 report.invitationAction={stage:'verify-pending'};
 const action=report.invitationAction;
 async function readInvitation(){
  const [row]=await db`
   select i.status,i.accepted_at is not null as accepted,i.person_id,
    (select count(*)::int from app_user u where u.tenant_id=i.tenant_id and u.person_id=i.person_id) as accounts
   from app_invitation i where i.tenant_id=${employee.tenantId}::uuid and i.id=${invitationId}::uuid
  `;
  assert(row&&row.person_id===employee.personId&&row.accounts===1,'Invitation must remain attached to one fictional account');
  return row;
 }
 async function visit(page,template,pass,open,heading,control){
  const row={template,role:'employee',pass,outcome:'failed'};
  observations.push(row);
  const started=performance.now();
  try{
   const response=await open();
   row.httpStatus=response?.status()??null;
   row.responseMs=Math.round(performance.now()-started);
   assert.equal(row.httpStatus,200);
   await page.getByRole('heading',{name:heading,exact:true}).waitFor({state:'visible',timeout});
   row.headingMs=Math.round(performance.now()-started);
   const witness=control(page);
   await witness.waitFor({state:'visible',timeout});
   row.controlVisibleMs=Math.round(performance.now()-started);
   if(template===activationTemplate){
    await witness.and(page.locator('button:enabled')).waitFor({state:'visible',timeout});
   }
   row.controlReadyMs=Math.round(performance.now()-started);
   row.outcome='usable-content';
  }finally{
   row.elapsedMs=Math.round(performance.now()-started);
   save();
  }
 }
 const [context,wrongContext]=await Promise.all([signedInContext(employee),signedInContext(fixture.users[5])]);
 try{
  assert.equal((await readInvitation()).status,'pending');
  const wrongPage=await wrongContext.newPage();
  action.stage='wrong-account';
  const denied=await wrongPage.goto(origin+activation,{waitUntil:'commit',timeout});
  assert.equal(denied?.status(),200);
  await wrongPage.getByRole('heading',{name:'Use a different account',exact:true}).waitFor({state:'visible',timeout});
  assert.equal(await wrongPage.locator('button.login-submit').count(),0);
  action.wrongAccountBlocked=true;
  const page=await context.newPage();
  const activate=page=>page.getByRole('link',{name:'Activate account',exact:true});
  const accept=page=>page.locator('button.login-submit');
  for(const pass of ['first','repeat']){
   action.stage='landing';
   await visit(page,landingTemplate,pass,()=>page.goto(origin+landing,{waitUntil:'commit',timeout}),
    "You've been invited",activate);
   assert(await activate(page).getAttribute('href')===activation,'The landing link must target this invitation');
   action.stage='activation';
   await visit(page,activationTemplate,pass,async()=>{
    const navigation=page.waitForEvent('response',{predicate:response=>response.url()===origin+activation
      &&response.request().isNavigationRequest(),timeout});
    const [response]=await Promise.all([navigation,activate(page).click({timeout})]);
    return response;
   },'Accept your invitation',accept);
  }
  action.stage='accept-first-click';
  const started=performance.now();
  const posted=page.waitForResponse(response=>new URL(response.url()).pathname==='/login/api/accept-invite'
   &&response.request().method()==='POST',{timeout});
  const [result]=await Promise.all([posted,accept(page).click({timeout})]);
  action.responseMs=Math.round(performance.now()-started);
  action.httpStatus=result.status();
  assert.equal(action.httpStatus,200);
  assert((await result.json()).step==='activated','The native invitation response must confirm activation');
  action.stage='persistence';
  const accepted=await readInvitation();
  assert(accepted.status==='accepted'&&accepted.accepted,'The exact invitation must be consumed');
  action.persisted=true;
  action.stage='single-use';
  const used=await wrongPage.goto(origin+activation,{waitUntil:'commit',timeout});
  assert.equal(used?.status(),200);
  await wrongPage.getByRole('heading',{name:'This invitation is no longer valid',exact:true}).waitFor({state:'visible',timeout});
  action.singleUseVerified=true;
  action.stage='complete';
 }catch{
  // Browser errors may contain the invitation URL. Retain only the fixed stage names and measurements.
  throw new Error('Fictional invitation browser check failed at '+action.stage);
 }finally{
  save();
  await Promise.all([context.close(),wrongContext.close()]);
 }
}
