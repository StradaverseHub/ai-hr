/** AI v2 Phase 1 W11 — the protected case route (migration 0959, ADR-0173) on fictional data, through the real owners,
 * roles and forced row-level security. Only the provider adapter's network call is stubbed in the sensitive-reply case,
 * and it is never reached: a routed turn calls no model. The provider-data review lookup is isolated as in
 * test/teras-conversation-turn.test.ts; no approval is claimed by this file.
 *
 * Proves: the author and the case's handler read a case; an unassigned company HR administrator, a group administrator
 * while a handler exists, a manager, another employee, another tenant and an agent read nothing; a case about a handler
 * reaches another handler or the group administrator and never that handler; an excluded group administrator never
 * reads, and a case with every possible reader excluded is kept, read by nobody, with the author told; readers are
 * notified of a new case and the author of a status change, with no content in the notice; designation is an
 * administrator's audited grant, never anyone's own, even in a company with one HR administrator; every creation, read,
 * status change and note is audited and a refused read records nothing; the text round-trips encrypted and a wrong
 * binding fails; the lifecycle and its guard; person erasure; the sensitive reply offers the route only where it is set
 * up, calls no model and stores no words.
 * The restricted-owner proofs (definer lookups and erasure under forced RLS) are in test/private-cases-owner.test.ts. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const review=vi.hoisted(()=>({approved:true}));
vi.mock('../lib/ai/provider-data-reviews',async original=>{const actual=await original<typeof import('../lib/ai/provider-data-reviews')>();
 return{...actual,providerDataReviewStatus:(contractId:string)=>contractId==='teras_harness_turn_v1'?(review.approved?'approved':'pending'):actual.providerDataReviewStatus(contractId),
  assertProviderDataContractReviewed:(contractId:string,digest:string)=>{if(contractId==='teras_harness_turn_v1'&&review.approved)return;actual.assertProviderDataContractReviewed(contractId,digest);}};});
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {erasePersonPii} from '../core/pdpa';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {conversationRoute} from '../core/teras-wiring/switch';
import {runConversationTurn} from '../core/teras-wiring/turn';
import {recordChatTurn} from '../core/teras-chats';
import {routeReply} from '../core/harness/runner';
import {HARNESS_SPEC} from '../core/harness/spec';
import {PRIVATE_CASE_START_PATH,privateCaseRouteAvailable} from '../core/private-case-route';
import {addPrivateCaseNote,caseHandlerAdmin,designateCaseHandler,handlesPrivateCases,listHandledPrivateCases,listOwnPrivateCases,openPrivateCase,
 privateCaseAad,privateCaseIntake,privateCaseNoteAad,PrivateCaseError,readHandledPrivateCase,readOwnPrivateCase,revokeCaseHandler,setPrivateCaseStatus} from '../core/private-cases';
import {decryptSecret,encryptSecret} from '../lib/ai/crypto';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import {adminCtx,closeAll,createAppUser,entitledCtx,eventTypesFor,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,group:SessionContext;
type Actor={ctx:SessionContext&{userId:string};personId:string;employmentId:string};
async function hire(name:string,role:'employee'|'manager'|'hr_admin',scoped=false):Promise<Actor>{
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);await grantAssistant(adminCtx(b),{appUserId:userId});
 if(scoped)await owner.db.execute(sql`update public.role_assignment set company_id=${b.companyId}::uuid where tenant_id=${b.tenantId}::uuid and app_user_id=${userId}::uuid and role='hr_admin'`);
 return{ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:scoped?b.companyId:null}]},personId:hired.personId,employmentId:hired.employmentId};
}
const TEXT='Fictional grievance: my supervisor keeps moving my shifts at short notice.';
const open=(author:Actor,extra:Partial<Parameters<typeof openPrivateCase>[1]>={})=>openPrivateCase(author.ctx,{companyId:b.companyId,category:'grievance',text:TEXT,...extra}).then(row=>row.caseId);
const designate=(userId:string,by:SessionContext=group)=>designateCaseHandler(by,{companyId:b.companyId,appUserId:userId}).then(row=>row.handlerId);
const refusedWith=async(promise:Promise<unknown>,code:string)=>{const error=await promise.then(()=>null,(caught:unknown)=>caught);expect(error).toBeInstanceOf(PrivateCaseError);expect((error as PrivateCaseError).code).toBe(code);};
const ids=(rows:readonly {id:string}[])=>rows.map(row=>row.id).sort();
const seen=(ctx:SessionContext)=>withTenant(ctx,async tx=>({cases:ids(await tx.execute<{id:string}>(sql`select id from public.private_case`)),
 notes:(await tx.execute(sql`select id from public.private_case_note`)).length,events:(await tx.execute(sql`select id from public.private_case_event`)).length}));
const events=(caseId:string)=>owner.db.execute<{kind:string;actor:string;from_status:string|null;to_status:string|null}>(sql`select kind,actor_user_id as actor,from_status,to_status
 from public.private_case_event where case_id=${caseId}::uuid order by at,id`).then(rows=>rows.map(row=>({...row})));
const stored=(caseId:string)=>owner.db.execute<{status:string;route:string;excluded:string[];erasure:boolean;body:string}>(sql`select status,route,excluded_user_ids as excluded,
 erasure_requested_at is not null as erasure,body_ciphertext as body from public.private_case where id=${caseId}::uuid`).then(rows=>rows[0]);

beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 review.approved=true;
 vi.stubEnv('AI_CONFIG_SECRET','fictional-private-case-passphrase-0123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-private-case-proposal-secret-0123456789abcdef');
 await resetDb();b=await seedBase();for(const code of ['assistant','claims'])await setModule(b.tenantId,code,'active');
 group=adminCtx(b);
});

describe('access',()=>{
 it('the author and the assigned handler read the case; an unassigned HR administrator, the group administrator, a manager, another employee, another tenant and an agent read nothing',async()=>{
  const author=await hire('Fictional Case Author','employee'),handler=await hire('Fictional Case Handler','employee'),companyAdmin=await hire('Fictional Company Administrator','hr_admin',true);
  const manager=await hire('Fictional Line Manager','manager'),peer=await hire('Fictional Neighbour','employee');
  // Not set up yet: no handler, so nobody can open a case and the route is not offered.
  expect((await privateCaseIntake(author.ctx)).companies).toEqual([]);
  expect(await privateCaseRouteAvailable(author.ctx,b.companyId)).toBe(false);
  await refusedWith(open(author),'not_set_up');
  await designate(handler.ctx.userId);
  expect(await privateCaseRouteAvailable(author.ctx,b.companyId)).toBe(true);
  const intake=await privateCaseIntake(author.ctx);
  // Everyone who could read it is named, handlers first: here the handler and the tenant's group administrator.
  expect(intake.companies.map(row=>row.id)).toEqual([b.companyId]);
  expect(intake.readers).toEqual([{userId:handler.ctx.userId,name:'Fictional Case Handler',kind:'handler'},{userId:b.adminUserId,name:null,kind:'group_admin'}]);
  const caseId=await open(author);
  await addPrivateCaseNote(handler.ctx,{caseId,text:'Fictional handler note: call the author on Monday.'});

  const mine=await readOwnPrivateCase(author.ctx,caseId);
  expect(mine).toMatchObject({id:caseId,category:'grievance',status:'received',text:TEXT});expect(mine.history.map(step=>step.status)).toEqual(['received']);
  expect((await listOwnPrivateCases(author.ctx)).map(row=>row.id)).toEqual([caseId]);
  const handled=await readHandledPrivateCase(handler.ctx,caseId);
  expect(handled).toMatchObject({id:caseId,author:'Fictional Case Author',text:TEXT,status:'received',next:['in_review','closed']});
  expect(handled.notes.map(note=>note.text)).toEqual(['Fictional handler note: call the author on Monday.']);
  expect((await listHandledPrivateCases(handler.ctx)).map(row=>row.id)).toEqual([caseId]);
  expect(await handlesPrivateCases(handler.ctx)).toBe(true);
  // The author never sees notes, nor who read the case.
  expect(await seen(author.ctx)).toEqual({cases:[caseId],notes:0,events:1});
  // A handler sees the case, its note and its whole audit.
  expect((await seen(handler.ctx)).cases).toEqual([caseId]);

  const foreign=await seedBase();
  const principal=await ensureAgentPrincipal(owner.db,b.tenantId),agent=agentContext(b.tenantId,principal,harnessSnapshot(b.tenantId));
  const outsiders:[string,SessionContext][]=[['company HR administrator',companyAdmin.ctx],['group administrator',group],['manager',manager.ctx],['employee',peer.ctx],
   ['another tenant',{...author.ctx,tenantId:foreign.tenantId}],['agent',agent]];
  for(const [who,ctx] of outsiders){
   expect(await seen(ctx),who).toEqual({cases:[],notes:0,events:0});
   await expect(readHandledPrivateCase(ctx,caseId),who).rejects.toMatchObject({code:'not_found'});
   await expect(readOwnPrivateCase(ctx,caseId),who).rejects.toBeInstanceOf(PrivateCaseError);
   expect(await withTenant(ctx,tx=>tx.execute(sql`select * from app.private_case_names(${caseId}::uuid)`)),who).toEqual([]);
   expect(await withTenant(ctx,tx=>tx.execute(sql`update public.private_case set status='closed' where id=${caseId}::uuid returning id`)).catch(()=>[]),who).toEqual([]);
   await expect(addPrivateCaseNote(ctx,{caseId,text:'Fictional intrusion'}),who).rejects.toBeInstanceOf(PrivateCaseError);
  }
  expect(await handlesPrivateCases(peer.ctx)).toBe(false);expect(await listHandledPrivateCases(companyAdmin.ctx)).toEqual([]);
  // Untouched by every refusal: one case, one note, the author's and the handler's audit only.
  expect((await events(caseId)).map(row=>[row.kind,row.actor])).toEqual([['created',author.ctx.userId],['note_added',handler.ctx.userId],['read',author.ctx.userId],['read',handler.ctx.userId]]);
  expect((await stored(caseId)).status).toBe('received');

  // The application role holds exactly the reviewed privileges, and row security is forced on all four tables.
  const [grants]=await owner.db.execute<Record<string,boolean>>(sql`select
   has_table_privilege('ai_hr_app','public.private_case','SELECT') as case_select,has_table_privilege('ai_hr_app','public.private_case','DELETE') as case_delete,
   has_column_privilege('ai_hr_app','public.private_case','status','UPDATE') as case_status,has_column_privilege('ai_hr_app','public.private_case','body_ciphertext','UPDATE') as case_body,
   has_column_privilege('ai_hr_app','public.private_case','excluded_user_ids','UPDATE') as case_excluded,has_column_privilege('ai_hr_app','public.private_case','erasure_requested_at','UPDATE') as case_erasure,
   has_table_privilege('ai_hr_app','public.private_case_note','UPDATE') as note_update,has_table_privilege('ai_hr_app','public.private_case_note','DELETE') as note_delete,
   has_table_privilege('ai_hr_app','public.private_case_event','UPDATE') as event_update,has_table_privilege('ai_hr_app','public.private_case_event','DELETE') as event_delete,
   has_table_privilege('ai_hr_app','public.private_case_event','TRUNCATE') as event_truncate,has_table_privilege('ai_hr_app','public.private_case_handler','DELETE') as handler_delete,
   has_column_privilege('ai_hr_app','public.private_case_handler','app_user_id','UPDATE') as handler_user,has_column_privilege('ai_hr_app','public.private_case_handler','revoked_at','UPDATE') as handler_revoke,
   (select bool_and(relforcerowsecurity and relrowsecurity) from pg_class where oid in ('public.private_case'::regclass,'public.private_case_note'::regclass,'public.private_case_event'::regclass,'public.private_case_handler'::regclass)) as forced`);
  expect(grants).toEqual({case_select:true,case_delete:true,case_status:true,case_body:false,case_excluded:false,case_erasure:false,note_update:false,note_delete:false,
   event_update:false,event_delete:false,event_truncate:false,handler_delete:false,handler_user:false,handler_revoke:true,forced:true});
 });

 it('a case about a handler reaches another handler, or the group administrator, and never the handler it is about',async()=>{
  const author=await hire('Fictional Route Author','employee'),first=await hire('Fictional First Handler','employee'),second=await hire('Fictional Second Handler','employee');
  const companyAdmin=await hire('Fictional Route Company Administrator','hr_admin',true);
  await designate(first.ctx.userId);await designate(second.ctx.userId);
  // Who handles the case: the handler policy, so an author's own visibility of what they wrote is not counted here.
  const reach=async(caseId:string)=>{const out:string[]=[];
   for(const [who,ctx] of [['first',first.ctx],['second',second.ctx],['group',group],['company admin',companyAdmin.ctx]] as const)
    if((await listHandledPrivateCases(ctx)).some(row=>row.id===caseId))out.push(who);
   return out;};
  // About the first handler: only the second reads it.
  const aboutFirst=await open(author,{excludedUserIds:[first.ctx.userId]});
  expect(await stored(aboutFirst)).toMatchObject({route:'handlers',excluded:[first.ctx.userId]});
  expect(await reach(aboutFirst)).toEqual(['second']);
  await expect(readHandledPrivateCase(first.ctx,aboutFirst)).rejects.toMatchObject({code:'not_found'});
  expect((await readHandledPrivateCase(second.ctx,aboutFirst)).text).toBe(TEXT);
  // About both handlers: the group administrator receives it, neither handler nor the company HR administrator.
  const aboutBoth=await open(author,{excludedUserIds:[first.ctx.userId,second.ctx.userId]});
  expect(await stored(aboutBoth)).toMatchObject({route:'group_admin'});
  expect(await reach(aboutBoth)).toEqual(['group']);
  expect((await readHandledPrivateCase(group,aboutBoth)).route).toBe('group_admin');
  // The author asks for the group administrator directly.
  const direct=await open(author,{sendTo:'group_admin'});
  expect(await reach(direct)).toEqual(['group']);
  // A handler who writes a case never handles it; the other handler does.
  const byHandler=await open(first);
  expect(await reach(byHandler)).toEqual(['second']);
  await expect(readHandledPrivateCase(first.ctx,byHandler)).rejects.toMatchObject({code:'not_found'});
  expect((await readOwnPrivateCase(first.ctx,byHandler)).text).toBe(TEXT);
  // Row security agrees: the excluded handler and the company HR administrator see none of these cases at all.
  expect((await seen(first.ctx)).cases).toEqual([byHandler]);expect((await seen(companyAdmin.ctx)).cases).toEqual([]);
  // Only a possible reader (a handler or a group administrator) can be left out, and an invalid choice stores nothing.
  await refusedWith(open(author,{excludedUserIds:[companyAdmin.ctx.userId]}),'invalid');
  await refusedWith(open(author,{sendTo:'everyone'}),'invalid');
  // The intake form names the possible readers, never the author themself.
  expect((await privateCaseIntake(first.ctx)).readers.filter(row=>row.kind==='handler').map(row=>row.userId)).toEqual([second.ctx.userId]);
  expect((await owner.db.execute(sql`select id from public.private_case where tenant_id=${b.tenantId}::uuid`)).length).toBe(4);
 });

 it('an excluded group administrator never reads; with every possible reader excluded the case is kept, read by nobody, and the author is told',async()=>{
  const author=await hire('Fictional Exclusion Author','employee'),handler=await hire('Fictional Exclusion Handler','employee'),otherGroup=await hire('Fictional Second Group Administrator','hr_admin');
  await designate(handler.ctx.userId);
  const reach=async(caseId:string)=>{const out:string[]=[];
   for(const [who,ctx] of [['handler',handler.ctx],['group',group],['other group',otherGroup.ctx]] as const)if((await listHandledPrivateCases(ctx)).some(row=>row.id===caseId))out.push(who);
   return out;};
  // About the handler and one group administrator: the other group administrator reads it.
  const one=await openPrivateCase(author.ctx,{companyId:b.companyId,category:'harassment',text:TEXT,excludedUserIds:[handler.ctx.userId,b.adminUserId]});
  expect(one.reachable).toBe(true);expect(await reach(one.caseId)).toEqual(['other group']);
  await expect(readHandledPrivateCase(group,one.caseId)).rejects.toMatchObject({code:'not_found'});
  expect((await seen(group)).cases).toEqual([]);
  // Sent to the group administrators directly, about one of them: never that one.
  const direct=await openPrivateCase(author.ctx,{companyId:b.companyId,category:'other',text:TEXT,sendTo:'group_admin',excludedUserIds:[otherGroup.ctx.userId]});
  expect(await reach(direct.caseId)).toEqual(['group']);
  // Everyone excluded: the case exists, nobody reads it, and the author's screens say so.
  const nobody=await openPrivateCase(author.ctx,{companyId:b.companyId,category:'grievance',text:TEXT,excludedUserIds:[handler.ctx.userId,b.adminUserId,otherGroup.ctx.userId]});
  expect(nobody.reachable).toBe(false);
  expect(await reach(nobody.caseId)).toEqual([]);
  for(const ctx of [handler.ctx,group,otherGroup.ctx])expect((await seen(ctx)).cases).not.toContain(nobody.caseId);
  expect((await stored(nobody.caseId)).status).toBe('received');
  const mine=await readOwnPrivateCase(author.ctx,nobody.caseId);
  expect(mine).toMatchObject({text:TEXT,reachable:false});
  expect((await listOwnPrivateCases(author.ctx)).map(row=>[row.id,row.reachable]).sort()).toEqual([[one.caseId,true],[direct.caseId,true],[nobody.caseId,false]].sort());
  // A group administrator who wrote a case never reads it either: with the handler excluded, the other one does.
  const byGroup=await openPrivateCase(otherGroup.ctx,{companyId:b.companyId,category:'safety',text:TEXT,excludedUserIds:[handler.ctx.userId]});
  expect(await reach(byGroup.caseId)).toEqual(['group']);
 });

 it('only an administrator of the company designates a handler, an HR administrator never themself; every change is audited and revoking ends access',async()=>{
  const author=await hire('Fictional Grant Author','employee'),handler=await hire('Fictional Grant Handler','employee'),companyAdmin=await hire('Fictional Grant Company Administrator','hr_admin',true);
  await refusedWith(designateCaseHandler(author.ctx,{companyId:b.companyId,appUserId:author.ctx.userId}),'not_allowed');
  await refusedWith(designateCaseHandler(companyAdmin.ctx,{companyId:b.companyId,appUserId:companyAdmin.ctx.userId}),'not_allowed');
  // Directly, too: the database refuses an employee's and an HR administrator's own designation.
  for(const [ctx,userId] of [[author.ctx,handler.ctx.userId],[companyAdmin.ctx,companyAdmin.ctx.userId]] as const)
   await expect(withTenant(ctx,tx=>tx.execute(sql`insert into public.private_case_handler(tenant_id,company_id,app_user_id,granted_by_user_id)
    values(${b.tenantId}::uuid,${b.companyId}::uuid,${userId}::uuid,${ctx.userId}::uuid)`))).rejects.toThrow();
  const handlerId=await designate(handler.ctx.userId,companyAdmin.ctx);
  await refusedWith(designate(handler.ctx.userId,companyAdmin.ctx),'conflict');
  expect(await eventTypesFor(b.tenantId,handlerId)).toEqual(['private-case-handler.designated']);
  const admin=await caseHandlerAdmin(companyAdmin.ctx);
  expect(admin.grants.map(grant=>[grant.userId,grant.revokedAt])).toEqual([[handler.ctx.userId,null]]);
  expect(admin.candidates.map(row=>row.userId)).not.toContain(companyAdmin.ctx.userId);
  expect((await caseHandlerAdmin(group)).candidates.map(row=>row.userId)).not.toContain(group.userId);
  await refusedWith(caseHandlerAdmin(author.ctx),'not_allowed');
  const caseId=await open(author);
  expect((await readHandledPrivateCase(handler.ctx,caseId)).text).toBe(TEXT);
  // Designating someone reads no case: the company HR administrator still reads nothing.
  expect((await seen(companyAdmin.ctx)).cases).toEqual([]);
  // A designated handler cannot rewrite or delete the grant; revocation keeps the row as history.
  await expect(withTenant(handler.ctx,tx=>tx.execute(sql`update public.private_case_handler set app_user_id=${author.ctx.userId}::uuid where id=${handlerId}::uuid`))).rejects.toThrow();
  await revokeCaseHandler(companyAdmin.ctx,{handlerId});
  await refusedWith(revokeCaseHandler(companyAdmin.ctx,{handlerId}),'not_found');
  expect(await eventTypesFor(b.tenantId,handlerId)).toEqual(['private-case-handler.designated','private-case-handler.revoked']);
  const [grant]=await owner.db.execute<{revoked:boolean;by:string}>(sql`select revoked_at is not null as revoked,revoked_by_user_id as by from public.private_case_handler where id=${handlerId}::uuid`);
  expect(grant).toEqual({revoked:true,by:companyAdmin.ctx.userId});
  // With no handler left the company is no longer set up; the open case falls to the group administrator.
  await expect(readHandledPrivateCase(handler.ctx,caseId)).rejects.toMatchObject({code:'not_found'});
  expect(await privateCaseRouteAvailable(author.ctx,b.companyId)).toBe(false);
  expect((await seen(group)).cases).toEqual([caseId]);
 });
});

describe('designation in a company with one HR administrator',()=>{
 it('the only HR administrator cannot designate themself; a group administrator designates them, and nobody designates themself',async()=>{
  const author=await hire('Fictional Single Author','employee'),soleAdmin=await hire('Fictional Sole Company Administrator','hr_admin',true),groupAdmin=await hire('Fictional Group Designator','hr_admin');
  const [admins]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.role_assignment where tenant_id=${b.tenantId}::uuid and role='hr_admin' and company_id=${b.companyId}::uuid`);
  expect(admins.n).toBe(1);
  await refusedWith(designateCaseHandler(soleAdmin.ctx,{companyId:b.companyId,appUserId:soleAdmin.ctx.userId}),'not_allowed');
  // A group administrator is an HR administrator too: no self-designation either.
  await refusedWith(designateCaseHandler(groupAdmin.ctx,{companyId:b.companyId,appUserId:groupAdmin.ctx.userId}),'not_allowed');
  expect(await owner.db.execute(sql`select id from public.private_case_handler where tenant_id=${b.tenantId}::uuid`)).toEqual([]);
  await designateCaseHandler(groupAdmin.ctx,{companyId:b.companyId,appUserId:soleAdmin.ctx.userId});
  const caseId=await open(author);
  expect((await readHandledPrivateCase(soleAdmin.ctx,caseId)).text).toBe(TEXT);
  expect((await caseHandlerAdmin(soleAdmin.ctx)).candidates.map(row=>row.userId)).not.toContain(soleAdmin.ctx.userId);
 });
});

describe('notices',()=>{
 const notices=(tenantId:string)=>owner.db.execute<{recipient:string;kind:string;title:string;body:string;link:string|null;severity:string;user:string|null;company:string|null;event:string|null}>(sql`
  select recipient_employment_id as recipient,kind,title,body,link_path as link,severity::text,recipient_user_id as user,company_id as company,source_event_id as event
  from public.notification where tenant_id=${tenantId}::uuid and kind like 'private-case.%' order by created_at,id`).then(rows=>rows.map(row=>({...row})));
 it('tells the case\'s readers that a case is waiting and the author that it changed, with a link and no content, and never an excluded reader',async()=>{
  await setModule(b.tenantId,'notifications','active');
  const author=await hire('Fictional Notice Author','employee'),first=await hire('Fictional Notice First','employee'),second=await hire('Fictional Notice Second','employee');
  await designate(first.ctx.userId);await designate(second.ctx.userId);
  const words='Fictional notice text: the supervisor shouted at Farid about the night roster.';
  const caseId=(await openPrivateCase(author.ctx,{companyId:b.companyId,category:'harassment',text:words,excludedUserIds:[second.ctx.userId]})).caseId;
  const waiting={kind:'private-case.waiting',title:'A private case is waiting',body:'Open Private cases to read it.',link:'/cases/'+caseId,severity:'action',user:null,company:null,event:null};
  // The first handler only: the second is excluded, the author never notified of their own case arriving.
  expect(await notices(b.tenantId)).toEqual([{recipient:first.employmentId,...waiting}]);
  await setPrivateCaseStatus(first.ctx,{caseId,expected:'received',status:'in_review'});
  await addPrivateCaseNote(first.ctx,{caseId,text:'Fictional note that must not notify anyone.'});
  await setPrivateCaseStatus(first.ctx,{caseId,expected:'in_review',status:'closed'});
  const updated={kind:'private-case.updated',title:'Your private case has an update',body:'Open My private cases to see it.',link:'/me/cases/'+caseId,severity:'info',user:null,company:null,event:null};
  const rows=await notices(b.tenantId);
  expect(rows).toEqual([{recipient:first.employmentId,...waiting},{recipient:author.employmentId,...updated},{recipient:author.employmentId,...updated}]);
  // No content: no category, status, name, word of the case or of a note, and no domain event that an administrator reads.
  const everything=JSON.stringify(await owner.db.execute(sql`select * from public.notification where tenant_id=${b.tenantId}::uuid`));
  expect(everything).not.toMatch(/harassment|Harassment|in_review|In review|closed|Closed|supervisor|Farid|night roster|Fictional Notice|Fictional note/);
  expect(await owner.db.execute(sql`select event_type from public.domain_event where tenant_id=${b.tenantId}::uuid and (event_type like 'private-case.%' or aggregate_id=${caseId}::uuid)`)).toEqual([]);
  // Each notice is the recipient's own: the second handler and the author see nothing of the first handler's.
  expect(await withTenant(second.ctx,tx=>tx.execute(sql`select id from public.notification where kind like 'private-case.%'`))).toEqual([]);
  expect((await withTenant(author.ctx,tx=>tx.execute<{kind:string}>(sql`select kind from public.notification where kind like 'private-case.%'`))).map(row=>row.kind)).toEqual(['private-case.updated','private-case.updated']);
  // A case nobody may read notifies nobody; without the notifications module nothing is written.
  const before=(await notices(b.tenantId)).length;
  await openPrivateCase(author.ctx,{companyId:b.companyId,category:'other',text:words,excludedUserIds:[first.ctx.userId,second.ctx.userId,b.adminUserId]});
  expect(await notices(b.tenantId)).toHaveLength(before);
  await setModule(b.tenantId,'notifications','disabled');
  await openPrivateCase(author.ctx,{companyId:b.companyId,category:'other',text:words});
  expect(await notices(b.tenantId)).toHaveLength(before);
 });
 it('sends the group administrators the notice when every handler is excluded, and no author notice on a close that erasure is waiting on',async()=>{
  await setModule(b.tenantId,'notifications','active');
  const author=await hire('Fictional Fallback Author','employee'),handler=await hire('Fictional Fallback Handler','employee'),groupAdmin=await hire('Fictional Fallback Group','hr_admin');
  await designate(handler.ctx.userId);
  const caseId=(await openPrivateCase(author.ctx,{companyId:b.companyId,category:'grievance',text:TEXT,excludedUserIds:[handler.ctx.userId]})).caseId;
  // The group administrator with an employment gets it; the tenant's seeded administrator has none, so no bell.
  expect((await notices(b.tenantId)).map(row=>[row.recipient,row.kind])).toEqual([[groupAdmin.employmentId,'private-case.waiting']]);
  await erasePersonPii(group,{subjectEmploymentId:author.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});
  expect(await setPrivateCaseStatus(groupAdmin.ctx,{caseId,expected:'received',status:'closed'})).toEqual({status:'closed',erased:true});
  expect((await notices(b.tenantId)).map(row=>row.kind)).toEqual(['private-case.waiting']);
 });
});

describe('audit',()=>{
 it('records the creation, every read, each status change and each note; the author sees creation and status changes only; a refused read records nothing',async()=>{
  const author=await hire('Fictional Audit Author','employee'),handler=await hire('Fictional Audit Handler','employee'),peer=await hire('Fictional Audit Peer','employee');
  await designate(handler.ctx.userId);
  const caseId=await open(author);
  await readOwnPrivateCase(author.ctx,caseId);
  await readHandledPrivateCase(handler.ctx,caseId);
  await expect(readHandledPrivateCase(peer.ctx,caseId)).rejects.toMatchObject({code:'not_found'});
  await setPrivateCaseStatus(handler.ctx,{caseId,expected:'received',status:'in_review'});
  await addPrivateCaseNote(handler.ctx,{caseId,text:'Fictional note for the audit.'});
  expect(await events(caseId)).toEqual([
   {kind:'created',actor:author.ctx.userId,from_status:null,to_status:null},
   {kind:'read',actor:author.ctx.userId,from_status:null,to_status:null},
   {kind:'read',actor:handler.ctx.userId,from_status:null,to_status:null},
   {kind:'status_changed',actor:handler.ctx.userId,from_status:'received',to_status:'in_review'},
   {kind:'note_added',actor:handler.ctx.userId,from_status:null,to_status:null}]);
  // The handler's view includes this read too, each row named.
  const audit=(await readHandledPrivateCase(handler.ctx,caseId)).audit;
  expect(audit.map(row=>[row.kind,row.actor,row.own])).toEqual([['created','Fictional Audit Author',false],['read','Fictional Audit Author',false],['read','Fictional Audit Handler',true],
   ['status_changed','Fictional Audit Handler',true],['note_added','Fictional Audit Handler',true],['read','Fictional Audit Handler',true]]);
  // The author's own view: creation and the status change, never the reads or the note.
  const history=(await readOwnPrivateCase(author.ctx,caseId)).history;
  expect(history.map(step=>step.status)).toEqual(['received','in_review']);
  expect(await withTenant(author.ctx,tx=>tx.execute<{kind:string}>(sql`select kind from public.private_case_event order by at,id`)).then(rows=>rows.map(row=>row.kind))).toEqual(['created','status_changed']);
  // Nobody forges or rewrites the trail: another login's read row, a lifecycle row from the author, an update or a delete.
  await expect(withTenant(peer.ctx,tx=>tx.execute(sql`insert into public.private_case_event(tenant_id,case_id,actor_user_id,kind) values(${b.tenantId}::uuid,${caseId}::uuid,${peer.ctx.userId}::uuid,'read')`))).rejects.toThrow();
  await expect(withTenant(author.ctx,tx=>tx.execute(sql`insert into public.private_case_event(tenant_id,case_id,actor_user_id,kind,from_status,to_status) values(${b.tenantId}::uuid,${caseId}::uuid,${author.ctx.userId}::uuid,'status_changed','in_review','closed')`))).rejects.toThrow();
  await expect(withTenant(handler.ctx,tx=>tx.execute(sql`update public.private_case_event set kind='read' where case_id=${caseId}::uuid`))).rejects.toThrow();
  await expect(withTenant(handler.ctx,tx=>tx.execute(sql`delete from public.private_case_event where case_id=${caseId}::uuid`))).rejects.toThrow();
  // Seven rows: the creation, two reads by each of the two, the status change and the note; the peer's refused read is absent.
  expect((await events(caseId)).map(row=>[row.kind,row.actor===author.ctx.userId?'author':row.actor===handler.ctx.userId?'handler':'other'])).toEqual([
   ['created','author'],['read','author'],['read','handler'],['status_changed','handler'],['note_added','handler'],['read','handler'],['read','author']]);
 });
});

describe('encryption',()=>{
 it('stores the text only as ciphertext bound to tenant, case and author; a wrong binding or a moved ciphertext fails; without the secret nothing is stored',async()=>{
  const author=await hire('Fictional Cipher Author','employee'),handler=await hire('Fictional Cipher Handler','employee'),other=await hire('Fictional Cipher Other','employee');
  await designate(handler.ctx.userId);
  const caseId=await open(author),otherCase=await open(other,{text:'Fictional other text.'});
  const {noteId}=await addPrivateCaseNote(handler.ctx,{caseId,text:'Fictional encrypted note.'});
  const everything=JSON.stringify(await owner.db.execute(sql`select c.*,n.* from public.private_case c left join public.private_case_note n on n.case_id=c.id`));
  expect(everything).not.toMatch(/supervisor|shifts|Fictional encrypted note|Fictional other text/);
  const row=await stored(caseId);
  expect(decryptSecret(row.body,privateCaseAad(b.tenantId,caseId,author.ctx.userId))).toBe(TEXT);
  for(const aad of [privateCaseAad(randomUUID(),caseId,author.ctx.userId),privateCaseAad(b.tenantId,otherCase,author.ctx.userId),privateCaseAad(b.tenantId,caseId,other.ctx.userId)])
   expect(()=>decryptSecret(row.body,aad)).toThrow();
  const [note]=await owner.db.execute<{body:string}>(sql`select body_ciphertext as body from public.private_case_note where id=${noteId}::uuid`);
  expect(decryptSecret(note.body,privateCaseNoteAad(b.tenantId,caseId,author.ctx.userId,noteId,handler.ctx.userId))).toBe('Fictional encrypted note.');
  expect(()=>decryptSecret(note.body,privateCaseNoteAad(b.tenantId,caseId,author.ctx.userId,randomUUID(),handler.ctx.userId))).toThrow();
  expect(()=>decryptSecret(note.body,privateCaseNoteAad(b.tenantId,caseId,author.ctx.userId,noteId,author.ctx.userId))).toThrow();
  // A ciphertext moved onto another case does not open there.
  await owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);
   await tx.execute(sql`update public.private_case set body_ciphertext=${row.body} where id=${otherCase}::uuid`);});
  await expect(readOwnPrivateCase(other.ctx,otherCase)).rejects.toMatchObject({code:'unavailable'});
  // The database refuses readable text.
  await expect(owner.db.execute(sql`insert into public.private_case(id,tenant_id,company_id,author_user_id,category,body_ciphertext)
   values(${randomUUID()}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${author.ctx.userId}::uuid,'other','readable words are never stored here at all')`)).rejects.toThrow();
  // Fail closed: without the secret nothing is written.
  const before=(await owner.db.execute(sql`select id from public.private_case`)).length;
  vi.stubEnv('AI_CONFIG_SECRET','');
  await refusedWith(open(author),'unavailable');
  expect((await privateCaseIntake(author.ctx)).storable).toBe(false);
  expect((await owner.db.execute(sql`select id from public.private_case`)).length).toBe(before);
 });
});

describe('lifecycle',()=>{
 it('moves received, in review, closed; nothing else about a case changes; notes are added only while it is open',async()=>{
  const author=await hire('Fictional Lifecycle Author','employee'),handler=await hire('Fictional Lifecycle Handler','employee');
  await designate(handler.ctx.userId);
  const caseId=await open(author);
  await refusedWith(setPrivateCaseStatus(handler.ctx,{caseId,expected:'in_review',status:'closed'}),'conflict');
  await refusedWith(setPrivateCaseStatus(handler.ctx,{caseId,expected:'received',status:'received'}),'invalid');
  await refusedWith(setPrivateCaseStatus(author.ctx,{caseId,expected:'received',status:'closed'}),'not_found');
  expect(await setPrivateCaseStatus(handler.ctx,{caseId,expected:'received',status:'in_review'})).toEqual({status:'in_review',erased:false});
  // The handler's role changes the status only, and only forwards.
  await expect(withTenant(handler.ctx,tx=>tx.execute(sql`update public.private_case set category='other' where id=${caseId}::uuid`))).rejects.toThrow();
  await expect(withTenant(handler.ctx,tx=>tx.execute(sql`update public.private_case set status='received' where id=${caseId}::uuid`))).rejects.toThrow();
  expect(await setPrivateCaseStatus(handler.ctx,{caseId,expected:'in_review',status:'closed'})).toEqual({status:'closed',erased:false});
  await expect(withTenant(handler.ctx,tx=>tx.execute(sql`update public.private_case set status='in_review' where id=${caseId}::uuid`))).rejects.toThrow();
  await refusedWith(addPrivateCaseNote(handler.ctx,{caseId,text:'Too late.'}),'conflict');
  const detail=await readHandledPrivateCase(handler.ctx,caseId);
  expect(detail).toMatchObject({status:'closed',next:[]});
  const [times]=await owner.db.execute<{closed:boolean;version:number}>(sql`select closed_at is not null as closed,version from public.private_case where id=${caseId}::uuid`);
  expect(times).toEqual({closed:true,version:3});
  // Closed cases cannot be deleted by their handler unless an erasure is waiting on them.
  expect(await withTenant(handler.ctx,tx=>tx.execute(sql`delete from public.private_case where id=${caseId}::uuid returning id`))).toEqual([]);
  expect((await readOwnPrivateCase(author.ctx,caseId)).history.map(step=>step.status)).toEqual(['received','in_review','closed']);
 });
});

describe('erasure',()=>{
 it('person erasure deletes the person’s closed cases and marks open ones, which go when their handler closes them; the report names no case',async()=>{
  const author=await hire('Fictional Erasure Author','employee'),handler=await hire('Fictional Erasure Handler','employee'),peer=await hire('Fictional Erasure Peer','employee');
  await designate(handler.ctx.userId);
  const closed=await open(author),openCase=await open(author,{category:'harassment'}),theirs=await open(peer);
  await addPrivateCaseNote(handler.ctx,{caseId:closed,text:'Fictional closing note.'});
  await setPrivateCaseStatus(handler.ctx,{caseId:closed,expected:'received',status:'closed'});
  const report=await erasePersonPii(group,{subjectEmploymentId:author.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});
  expect(JSON.stringify(report)).not.toMatch(/private|case/i);
  const left=await owner.db.execute<{id:string;erasure:boolean}>(sql`select id,erasure_requested_at is not null as erasure from public.private_case where tenant_id=${b.tenantId}::uuid order by id`);
  expect(left.map(row=>({...row})).sort((x,y)=>x.id<y.id?-1:1)).toEqual([{id:openCase,erasure:true},{id:theirs,erasure:false}].sort((x,y)=>x.id<y.id?-1:1));
  expect(await owner.db.execute(sql`select 1 from public.private_case_note where case_id=${closed}::uuid`)).toHaveLength(0);
  expect(await owner.db.execute(sql`select 1 from public.private_case_event where case_id=${closed}::uuid`)).toHaveLength(0);
  // The administrator who erased reads none of them, and the function refuses outside an admitted erasure.
  expect((await seen(group)).cases).toEqual([]);
  await expect(withTenant(group,tx=>tx.execute(sql`select app.private_cases_redact(${peer.employmentId}::uuid) as touched`))).rejects.toThrow();
  // The handler sees the open case marked, and closing it deletes it.
  expect((await listHandledPrivateCases(handler.ctx)).find(row=>row.id===openCase)?.erasureRequested).toBe(true);
  expect(await setPrivateCaseStatus(handler.ctx,{caseId:openCase,expected:'received',status:'closed'})).toEqual({status:'closed',erased:true});
  expect(ids(await owner.db.execute<{id:string}>(sql`select id from public.private_case where tenant_id=${b.tenantId}::uuid`))).toEqual([theirs]);
  // Erasure only marks: nothing else about the open case changed, and the marker never outlives the transaction.
  expect((await readHandledPrivateCase(handler.ctx,theirs)).text).toBe(TEXT);
 });
});

describe('the sensitive reply',()=>{
 async function openRouter(){
  await owner.db.insert(schema.aiProviderConfig).values({tenantId:b.tenantId,provider:'openrouter',model:'fictional/model',apiKeyCiphertext:encryptSecret('fictional-no-network-key',b.tenantId),keyLast4:'-key',isActive:true,
   providerOptions:{version:1,routing:{allowedProviders:['azure'],allowFallbacks:false,sort:'latency'}}});
 }
 it('offers the private case route only where it is set up, leads a crisis with emergency help, calls no model and stores no words',async()=>{
  const switcher=await hire('Fictional Switch Administrator','hr_admin'),author=await hire('Fictional Sensitive Author','employee'),handler=await hire('Fictional Sensitive Handler','employee');
  await openRouter();await setWorkerSwitch(switcher.ctx,{workerId:'conversation',enabled:true});
  // A routed turn calls no model: any provider call here fails the test.
  const adapter=vi.spyOn(openrouterAdapter,'converse').mockImplementation(async()=>{throw new Error('A routed sensitive turn must not reach a provider.');});
  const ask=async(question:string)=>{const route=await conversationRoute(author.ctx);if(route.route!=='harness')throw Error('Expected the harness route.');
   return runConversationTurn(author.ctx,route,{question,companyId:b.companyId,locale:'en'});};
  const grievance='I want to file a grievance against my manager for moving my shifts.',crisis='I want to end my life.';
  // Not set up: the HR contact alone, exactly as before.
  const before=await ask(grievance);
  expect(before).toMatchObject({sensitive:true,crisis:false,caseRoute:null,reply:routeReply()});
  await designate(handler.ctx.userId);
  const routed=await ask(grievance);
  expect(routed).toMatchObject({sensitive:true,crisis:false,caseRoute:PRIVATE_CASE_START_PATH,reads:[],suggestion:null});
  // Spec v18 names the case route (ADR-0173 §3) and v20 names it in the text without a link: the screen's route note
  // carries the one link (conversation-reply).
  expect(HARNESS_SPEC.sensitive.contact.caseRoute).toBe(PRIVATE_CASE_START_PATH);expect(routed.reply).toBe(routeReply(true));
  expect(routed.reply).toContain('start a private case with HR');expect(routed.reply).not.toContain('/me/cases/new');expect(before.reply).not.toContain('private case');
  const urgent=await ask(crisis);
  expect(urgent).toMatchObject({sensitive:true,crisis:true,caseRoute:PRIVATE_CASE_START_PATH});
  expect(urgent.reply.startsWith(HARNESS_SPEC.sensitive.crisisReply)).toBe(true);
  expect(adapter).not.toHaveBeenCalled();
  // No words of a routed turn anywhere: the outcome records, task memory, retired exchanges and a stored chat turn.
  for(const turn of [routed,urgent])await recordChatTurn(author.ctx,{conversationId:turn.trace.conversationId,conversationScope:JSON.stringify([b.companyId]),companyId:b.companyId,
   question:grievance,reply:turn.reply,modelRows:turn.modelTurn.map(row=>({role:row.role,content:row.content})),withheld:turn.sensitive});
  const everything=JSON.stringify(await owner.db.execute(sql`select
   (select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.teras_outcome_record r where r.tenant_id=${b.tenantId}::uuid) as outcomes,
   (select coalesce(jsonb_agg(to_jsonb(m)),'[]') from public.teras_task_memory m where m.tenant_id=${b.tenantId}::uuid) as memory,
   (select coalesce(jsonb_agg(to_jsonb(e)),'[]') from public.assistant_exchange e where e.tenant_id=${b.tenantId}::uuid) as exchanges,
   (select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.teras_chat_turn t where t.tenant_id=${b.tenantId}::uuid) as chat_turns`));
  expect(everything).not.toMatch(/grievance against|moving my shifts|end my life/);
  // The AI never opened a case.
  expect(await owner.db.execute(sql`select id from public.private_case where tenant_id=${b.tenantId}::uuid`)).toEqual([]);
 });
});
