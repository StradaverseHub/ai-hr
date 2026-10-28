/** Actual dev-cookie principal -> authenticated binder -> canonical store/command cases, UNRUN.
 * Next request cookies/locale are framework seams; identity SQL, custody, RLS and leave effects are real.
 * These do not claim production identity-provider verification; those owners remain unchanged.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined,locale:'en',cookies:vi.fn(),localeRead:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>{browser.cookies();return{get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined};},headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>{browser.localeRead();return browser.locale;}}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
import * as schema from '../db/schema';
import {handleAuthenticatedOwnLeaveBrowserCommand} from '../core/assistant-actions/own-leave-server';
import {getSession,getBrowserCommandSession} from '../lib/session';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,uid:string,employee:{employmentId:string;personId:string};
let preparation:Record<string,unknown>;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-lifecycle-storage-master-key');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 employee=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Browser Applicant',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 uid=await createAppUser(base.tenantId,employee.personId,'employee');await grantAssistant(adminCtx(base),{appUserId:uid});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:employee.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
 preparation={operation:'prepare',nomination:{action:'leave.apply',contractVersion:1,employmentId:employee.employmentId,leaveTypeId:base.annualLeaveTypeId,date:next.toISOString().slice(0,10),durationType:'full_day'},selection:{employmentId:employee.employmentId,leaveTypeId:base.annualLeaveTypeId},humanText:{reason:'Fictional private browser reason',employeeRemark:'Fictional private browser remark'}};
 browser.selected=uid;browser.locale='en';browser.cookies.mockClear();browser.localeRead.mockClear();
 vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
function request(body:unknown,headers:Record<string,string>={}){return new Request('https://hr.example/api/assistant/own-leave',{method:'POST',headers:{origin:'https://hr.example',host:'hr.example','content-type':'application/json','sec-fetch-site':'same-origin',...headers},body:JSON.stringify(body)});}
async function counts(){const [row]=await owner.db.execute<{requests:number;bodies:number;runs:number}>(sql`select
 (select count(*)::int from leave_request where tenant_id=${base.tenantId}::uuid) as requests,
 (select count(*)::int from app.assistant_own_leave_review_content c join app.assistant_own_leave_review r on r.id=c.action_id where r.tenant_id=${base.tenantId}::uuid) as bodies,
 (select count(*)::int from ai_model_run where tenant_id=${base.tenantId}::uuid) as runs`);return row;}
async function prepared(){const response=await handleAuthenticatedOwnLeaveBrowserCommand(request(preparation));expect(response.status).toBe(200);const value=await response.json();expect(value.kind).toBe('prepared');return value.review as{actionId:string;contractVersion:1;reviewedDigest:string};}
const confirmation=(review:Awaited<ReturnType<typeof prepared>>)=>({actionId:review.actionId,contractVersion:review.contractVersion,reviewedDigest:review.reviewedDigest});
describe('real unmounted own-leave server binding',()=>{
 it('requires a selected cookie even where ordinary development pages may use the fallback',async()=>{
  browser.selected=undefined;
  expect((await getSession()).userId).toBe(base.adminUserId);
  await expect(getBrowserCommandSession()).rejects.toThrow('selected browser session');
  const response=await handleAuthenticatedOwnLeaveBrowserCommand(request(preparation));expect(response.status).toBe(401);
  expect(await counts()).toEqual({requests:0,bodies:0,runs:0});
  browser.selected=randomUUID();expect((await handleAuthenticatedOwnLeaveBrowserCommand(request(preparation))).status).toBe(401);
  browser.selected=uid;expect((await handleAuthenticatedOwnLeaveBrowserCommand(request(preparation))).status).toBe(200);
 });
 it('cannot enable the dev selector or fallback on a real production authentication path',async()=>{
  vi.stubEnv('NODE_ENV','production');vi.stubEnv('ALLOW_DEMO_SESSION','false');
  const response=await handleAuthenticatedOwnLeaveBrowserCommand(request(preparation));expect(response.status).toBe(401);
  expect(await counts()).toEqual({requests:0,bodies:0,runs:0});
 });
 it('refuses foreign/bearer/posted authority before cookie resolution or storage work',async()=>{
  for(const req of [request(preparation,{origin:'https://foreign.example'}),request(preparation,{authorization:'Bearer fictional'}),request({...preparation,session:{userId:base.adminUserId},locale:'en'})]){
   const response=await handleAuthenticatedOwnLeaveBrowserCommand(req);expect([400,403]).toContain(response.status);
  }
  expect(browser.cookies).not.toHaveBeenCalled();expect(browser.localeRead).not.toHaveBeenCalled();expect(await counts()).toEqual({requests:0,bodies:0,runs:0});
 });
 it('prepares for the actual cookie actor and confirms/reconciles the exact canonical receipt once',async()=>{
  const review=await prepared();expect(await counts()).toEqual({requests:0,bodies:1,runs:0});
  const packet={operation:'confirm',confirmation:confirmation(review)};
  const first=await handleAuthenticatedOwnLeaveBrowserCommand(request(packet));expect(first.status).toBe(200);
  const completed=await first.json();expect(completed.kind).toBe('completed');
  const repeated=await handleAuthenticatedOwnLeaveBrowserCommand(request(packet));expect(repeated.status).toBe(200);expect(await repeated.json()).toEqual(completed);
  expect(await counts()).toEqual({requests:1,bodies:0,runs:0});
  const [record]=await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id,completed.receipt.leaveRequestId));
  const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,completed.receipt.submissionEventId));
  expect(record.employmentId).toBe(employee.employmentId);expect(event.aggregateId).toBe(record.id);expect(event.actorId).toBe(uid);expect(event.eventType).toBe('leave-request.submitted');
 });
 it('commits only expired private cleanup when a later confirmation is refused after grant revocation',async()=>{
  const review=await prepared();
  await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=${review.actionId}::uuid`);
  await revokeAssistant(adminCtx(base),{appUserId:uid});
  const response=await handleAuthenticatedOwnLeaveBrowserCommand(request({operation:'confirm',confirmation:confirmation(review)}));
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});
  expect(await counts()).toEqual({requests:0,bodies:0,runs:0});
  const [stored]=await owner.db.execute<{state:string}>(sql`select state from app.assistant_own_leave_review where id=${review.actionId}::uuid`);expect(stored.state).toBe('expired');
 });
 it('refuses stale/blocked current cookie identity and invalid server locale with bounded public bodies',async()=>{
  browser.locale='unknown-locale';let response=await handleAuthenticatedOwnLeaveBrowserCommand(request(preparation));expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'unavailable'});
  browser.locale='en';await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,uid));
  response=await handleAuthenticatedOwnLeaveBrowserCommand(request(preparation));expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'unavailable'});expect(await counts()).toEqual({requests:0,bodies:0,runs:0});
 });
});
