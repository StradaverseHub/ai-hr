/** Approved 0c0d8710: native year/company ownership, current authority, and exact set-based grid counts. */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {adminCtx,createAppUser,setModule,owner,migrateTestDb,resetDb,seedBase,closeAll,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {businessUnit,company,employment,person,roleAssignment} from '../db/schema';
import {setupChecker,setupCompanyStructureFixture,setupRewardLibrariesFixture,confirmFixturePat} from './rewards-setup-fixture';
import {changeCompanyRegistrationClassification} from '../core/company-registration-readiness';
import {defaultPolicy} from '../packs/rewards/model';
import {rewardReviewPlans,previewRewardYear,createRewardYear,previewRewardPlanGrid,saveRewardPlanGrid,rewardPlanBulkEdits,enqueueRewardPlanReviews,type RewardPlanGridEdit} from '../packs/rewards/review-plans';
import {rewardPlanReviewsJobHandler} from '../packs/rewards/review-plans-job';
let b:Base,bu:string;
const reason='Approved annual configuration for fictional companies';
const settings={effectiveFrom:'2027-01-01',joinedBefore:'2026-10-01',confirmedBy:'2026-12-31',activeAsOf:'2026-12-31',blockedFrom:'2026-10-01',blockedTo:'2026-12-31',snapshotDate:'2026-01-01'};
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');await setupChecker(adminCtx(b));const[u]=await owner.db.insert(businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'PLAN',name:'Plan Business Unit',label:'Plan Business Unit'}).returning();bu=u.id;await setupCompanyStructureFixture(adminCtx(b),[{companyId:b.companyId,businessUnitId:bu}],settings.snapshotDate);});
async function createYear(){const input={year:2026,settings};const preview=await previewRewardYear(adminCtx(b),input);return createRewardYear(adminCtx(b),input,preview.digest,reason);}
const toEdit=(r:Awaited<ReturnType<typeof rewardReviewPlans>>['rows'][number]):RewardPlanGridEdit=>({companyId:r.companyId,expectedRevision:r.revision,planType:r.planType,reason:r.reason,salaryVersionId:r.salaryVersionId,bonusVersionId:r.bonusVersionId,salaryReviewed:r.salarySuggestion.reviewed,bonusReviewed:r.bonusSuggestion.reviewed,branchAcknowledged:r.branchAcknowledged});
it('creates one draft including an incomplete choice, refuses duplicate years and stale edits, and audits the human actor',async()=>{
 await owner.db.execute(sql`insert into reward_company_exclusion(tenant_id,company_id,year,reason,created_by,award_type)values(${b.tenantId}::uuid,${b.companyId}::uuid,2026,'Existing uploaded participation must be retained',${b.adminUserId}::uuid,'uploaded')`);
 expect(await createYear()).toEqual({year:2026,created:1});
 const view=await rewardReviewPlans(adminCtx(b),{year:2026});expect(view.rows.map(r=>[r.companyId,r.status,r.headcount])).toEqual([[b.companyId,'draft',0]]);expect(view.coverage).toMatchObject({total:1,ready:0,missingSalary:1,missingBonus:1,missingPat:1});expect(view.rows[0].planType).toBe('uploaded');
 await expect(createYear()).rejects.toThrow(/already exists/);
 const edit={...toEdit(view.rows[0]),planType:'no_awards' as const,reason:'This legal entity has no awards this year'};const raw={year:2026,edits:[edit]},preview=await previewRewardPlanGrid(adminCtx(b),raw);await saveRewardPlanGrid(adminCtx(b),raw,preview.digest,reason);
 await expect(saveRewardPlanGrid(adminCtx(b),raw,preview.digest,reason)).rejects.toThrow(/changed/);
 const stored=await owner.db.execute<{plan_type:string;award_type:string}>(sql`select p.plan_type,e.award_type from reward_plan_year_company p join reward_company_exclusion e on e.tenant_id=p.tenant_id and e.company_id=p.company_id and e.year=p.year and e.ended_at is null where p.tenant_id=${b.tenantId}::uuid`);expect(stored).toEqual([{plan_type:'no_awards',award_type:'no_awards'}]);
 const events=await owner.db.execute<{actor_id:string;event_type:string}>(sql`select actor_id,event_type from domain_event where tenant_id=${b.tenantId}::uuid and event_type in('reward-plan.created','reward-plan.changed') order by sequence`);expect(events).toEqual([{actor_id:b.adminUserId,event_type:'reward-plan.created'},{actor_id:b.adminUserId,event_type:'reward-plan.changed'}]);
});
it('activates reviewed choices only with PAT, queues company work, and the worker resumes without duplicating reviews',async()=>{
 const libraries=await setupRewardLibrariesFixture(adminCtx(b),2026);await createYear();
 const view=await rewardReviewPlans(adminCtx(b),{year:2026}),edit={...toEdit(view.rows[0]),salaryVersionId:libraries.salary,bonusVersionId:libraries.bonus,salaryReviewed:true,bonusReviewed:true};
 let raw={year:2026,edits:[edit]},preview=await previewRewardPlanGrid(adminCtx(b),raw);await saveRewardPlanGrid(adminCtx(b),raw,preview.digest,reason);
 expect((await rewardReviewPlans(adminCtx(b),{year:2026})).rows[0].status).toBe('draft');
 await confirmFixturePat(adminCtx(b),b.companyId,2026,{targetCents:1000,forecastCents:null,actualCents:0,targetMonthsBp:20000});
 const fresh=await rewardReviewPlans(adminCtx(b),{year:2026});raw={year:2026,edits:[{...edit,expectedRevision:fresh.rows[0].revision}]};preview=await previewRewardPlanGrid(adminCtx(b),raw);await saveRewardPlanGrid(adminCtx(b),raw,preview.digest,reason);
 expect((await rewardReviewPlans(adminCtx(b),{year:2026})).coverage.ready).toBe(1);
 const queued=await enqueueRewardPlanReviews(adminCtx(b),{year:2026});expect(queued.jobId).toMatch(/^[a-f0-9-]{36}$/);
 const apply=()=>withTenant(adminCtx(b),tx=>rewardPlanReviewsJobHandler.applyStepTx(tx,adminCtx(b),{} as never,{seq:0,kind:'company',row_num:1,payload:{companyId:b.companyId,year:2026}},new Map()));
 await apply();await apply();expect((await owner.db.execute<{n:number}>(sql`select count(*)::int as n from reward_company_year_review where tenant_id=${b.tenantId}::uuid and year=2026`))[0].n).toBe(1);
 expect(await rewardPlanBulkEdits(adminCtx(b),{year:2026,operation:'accept-suggestions'})).toEqual([]);
},90_000);
it('admits scoped HR only to their rows, refuses a new year and raw cross-company writes, and keeps EC view only',async()=>{
 await createYear();const[p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional scoped HR',primaryEmail:randomUUID()+'@review-plans.test'}).returning();const userId=await createAppUser(b.tenantId,p.id,'employee');await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:userId,companyId:b.companyId,role:'hr_admin'});const scoped:SessionContext={...adminCtx(b),userId,personId:p.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 const view=await rewardReviewPlans(scoped,{year:2026});expect(view.rows.map(r=>r.companyId)).toEqual([b.companyId]);expect(view.canCreateYear).toBe(false);expect(view.rows[0].canEdit).toBe(true);
 await expect(previewRewardYear(scoped,{year:2027,settings})).rejects.toThrow(/Whole-group/);
 const [other]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Outside scoped HR'}).returning();
 await expect(withTenant(scoped,tx=>tx.execute(sql`insert into reward_plan_year_company(tenant_id,year,company_id)values(app.current_tenant_id(),2026,${other.id}::uuid)`))).rejects.toThrow();
 const[ecPerson]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional EC',primaryEmail:randomUUID()+'@review-plans.test'}).returning();await owner.db.insert(employment).values({tenantId:b.tenantId,companyId:b.companyId,personId:ecPerson.id,hiredOn:'2024-01-01',employeeCode:'EC-PLAN'});const ecUser=await createAppUser(b.tenantId,ecPerson.id,'employee');await owner.db.execute(sql`insert into reward_group_role_grant(tenant_id,user_id,role,active,revision)values(${b.tenantId}::uuid,${ecUser}::uuid,'ec',true,1)`);
 const ec:SessionContext={...adminCtx(b),userId:ecUser,personId:ecPerson.id,roles:['employee'],grants:[{role:'employee',companyId:null}]};const ecView=await rewardReviewPlans(ec,{year:2026});expect(ecView.canEdit).toBe(false);expect(ecView.rows.every(r=>!r.canEdit)).toBe(true);
});
it('reads seventy companies and a thousand employments with independent ordered counts and company filtering',async()=>{
 // At least three times the observed legacy fixture duration; hosted setup publishes one real group mapping.
 const extra=await owner.db.insert(company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:`Fictional legal employer ${String(i).padStart(2,'0')}`}))).returning();
 const units=await owner.db.insert(businessUnit).values(extra.map((c,i)=>({tenantId:b.tenantId,companyId:c.id,code:`BU${i}`,name:`Business Unit ${String(i).padStart(2,'0')}`}))).returning();
 await setupCompanyStructureFixture(adminCtx(b),extra.map((c,i)=>({companyId:c.id,businessUnitId:units[i].id})),settings.snapshotDate);
 const ids=[b.companyId,...extra.map(c=>c.id)],people=Array.from({length:1000},(_,i)=>({id:randomUUID(),companyId:ids[i%ids.length],name:`Fictional scale person ${i}`,email:randomUUID()+'@review-plans-scale.test',code:`RP${i}`}));
 await owner.db.execute(sql`insert into person(id,tenant_id,full_name,primary_email)select x.id,${b.tenantId}::uuid,x.name,x.email from jsonb_to_recordset(${JSON.stringify(people)}::jsonb)x(id uuid,name text,email text)`);
 await owner.db.execute(sql`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)select ${b.tenantId}::uuid,x.id,x."companyId",x.code,'2024-01-01'::date from jsonb_to_recordset(${JSON.stringify(people)}::jsonb)x(id uuid,"companyId" uuid,code text)`);
 const createStarted=performance.now();expect(await createYear()).toEqual({year:2026,created:70});const createMs=performance.now()-createStarted;
 const readStarted=performance.now(),view=await rewardReviewPlans(adminCtx(b),{year:2026}),readMs=performance.now()-readStarted;expect(view.rows).toHaveLength(70);expect(view.coverage.total).toBe(70);expect(view.rows.reduce((n,r)=>n+r.headcount,0)).toBe(1000);
 const expectedCounts=new Map(ids.map(id=>[id,people.filter(p=>p.companyId===id).length]));expect(view.rows.map(r=>[r.companyId,r.headcount])).toEqual(view.rows.map(r=>[r.companyId,expectedCounts.get(r.companyId)]));
 const filtered=await rewardReviewPlans(adminCtx(b),{year:2026,filters:{businessUnitId:bu}});expect(filtered.rows.map(r=>r.companyId)).toEqual([b.companyId]);expect(filtered.coverage.total).toBe(1);expect(filtered.rows[0].headcount).toBe(15);
 expect(view.rows.map(r=>[r.businessUnit??'',r.company,r.companyId])).toEqual([...view.rows].sort((a,b)=>(a.businessUnit??'').localeCompare(b.businessUnit??'')||a.company.localeCompare(b.company)||a.companyId.localeCompare(b.companyId)).map(r=>[r.businessUnit??'',r.company,r.companyId]));
 const edits=view.rows.map(r=>({...toEdit(r),reason:'Measured set-based configuration update'})),input={year:2026,edits},preview=await previewRewardPlanGrid(adminCtx(b),input),saveStarted=performance.now();await saveRewardPlanGrid(adminCtx(b),input,preview.digest,reason);const saveMs=performance.now()-saveStarted;
 console.info(JSON.stringify({measurement:'reward-review-plans-70-company-1000-employment',companies:70,employments:1000,createMs,saveMs,readMs,coverage:view.coverage.total,headcount:view.rows.reduce((n,r)=>n+r.headcount,0)}));

},180_000);
it('holds the worker Access lock shared so ordinary protected reads overlap a paused bulk chunk',async()=>{
 let ready!:()=>void,release!:()=>void;const acquired=new Promise<void>(r=>ready=r),continueWork=new Promise<void>(r=>release=r);
 const worker=withTenant(adminCtx(b),async tx=>{await rewardPlanReviewsJobHandler.beginChunkTx!(tx,adminCtx(b),{} as never);ready();await continueWork;});
 await acquired;
 try{const ordinary=await withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select app.access_workforce_write_lock()`);return(await tx.execute<{n:number}>(sql`select count(*)::int as n from company where tenant_id=app.current_tenant_id()`))[0].n;});expect(ordinary).toBeGreaterThan(0);}finally{release();await worker;}
},15_000);
it('consumes company-change nominations once and refuses a forged native rebind lease',async()=>{
 await createYear();const[next]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional newly eligible employer'}).returning();const[unit]=await owner.db.insert(businessUnit).values({tenantId:b.tenantId,companyId:next.id,code:'NEXT',name:'New employer BU'}).returning();
 await setupCompanyStructureFixture(adminCtx(b),[{companyId:next.id,businessUnitId:unit.id}],'2026-01-01');
 for(let i=0;i<4;i++)await owner.client.begin(tx=>tx`select app.reward_review_plan_company_tick()`);
 const rows=await owner.db.execute<{company_id:string;plan_version_id:string|null}>(sql`select company_id,plan_version_id from reward_plan_year_company where tenant_id=${b.tenantId}::uuid and year=2026 order by company_id`);expect(rows).toHaveLength(2);expect(rows.find(r=>r.company_id===next.id)?.plan_version_id).toBeNull();
 const events=await owner.db.execute<{payload:{companyId:string;year:number}}>(sql`select payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='reward-plan.company-added'`);expect(events.map(e=>[e.payload.companyId,e.payload.year])).toEqual([[next.id,2026]]);
 await withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select set_config('app.reward_review_plan_writing',txid_current()::text,true)`);const[r]=await tx.execute<{allowed:boolean}>(sql`select app.reward_review_plan_writing() as allowed`);expect(r.allowed).toBe(false);});
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`insert into app.reward_review_plan_write_lease values(app.current_tenant_id(),txid_current())`))).rejects.toThrow();
},90_000);

it('captures an existing mapped company becoming eligible and creates its open-year draft from that exact committed event',async()=>{
 await changeCompanyRegistrationClassification(adminCtx(b),{companyId:b.companyId,entityKind:'legal_entity',isTestEntity:true,expectedRevision:0});
 const input={year:2026,settings},preview=await previewRewardYear(adminCtx(b),input);expect(await createRewardYear(adminCtx(b),input,preview.digest,reason)).toEqual({year:2026,created:0});
 for(let i=0;i<4;i++)await owner.client.begin(tx=>tx`select app.reward_review_plan_company_tick()`);
 expect((await rewardReviewPlans(adminCtx(b),{year:2026})).rows).toEqual([]);
 await changeCompanyRegistrationClassification(adminCtx(b),{companyId:b.companyId,entityKind:'legal_entity',isTestEntity:false,expectedRevision:1});
 const[event]=await owner.db.execute<{id:string}>(sql`select id from domain_event where tenant_id=${b.tenantId}::uuid and event_type='company.registration-classification.changed' and payload->'after'->>'isTestEntity'='false' order by sequence desc limit 1`);
 expect(event).toBeTruthy();expect(await owner.db.execute(sql`select event_id from app.reward_review_plan_company_outbox where event_id=${event.id}::uuid`)).toHaveLength(1);
 for(let i=0;i<3;i++)await owner.client.begin(tx=>tx`select app.reward_review_plan_company_tick()`);
 const view=await rewardReviewPlans(adminCtx(b),{year:2026});expect(view.rows.map(r=>[r.companyId,r.status])).toEqual([[b.companyId,'draft']]);
 const notices=await owner.db.execute<{payload:{sourceEventId:string;companyId:string;year:number}}>(sql`select payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='reward-plan.company-added'`);expect(notices.map(n=>[n.payload.sourceEventId,n.payload.companyId,n.payload.year])).toEqual([[event.id,b.companyId,2026]]);
},90_000);
