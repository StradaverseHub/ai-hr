/** ADR 0181 Phase 2 pilot (migration 7210): precomputed company access on the Job descriptions read path.
 *
 * Equivalence (docs/adr/0181-addendum-precomputed-company-access.md section 7): on a fictional group of 70 companies
 * in a three-level tree with 1,000 employments, 140 Job descriptions and 280 revisions, the PREVIOUS policies (the
 * exact 0595 text, reinstated by this test) and the 7210 policies in each mode ('legacy', 'shadow', 'precomputed')
 * return identical rows, order and counts for every actor, under "All companies" and one company: the raw list,
 * count and revision history, the Job descriptions page (both pages, with its total) and the document read.
 * Actors cover group, subtree, leaf and second-tree administrators, a super administrator, a holder of both roles (claiming both or one), an
 * employee, a session claim narrower than the grant, a claim wider than the grant, an archived and a login-blocked
 * administrator. Phases: capability unsupported, capability enforced, an explicit deny saved through the real
 * access editor, a future-dated restructure the day before and on its effective day, a writer that bypassed the
 * triggers (caught by the rebuild check, failing closed to the legacy answer), and maintenance visible in the same
 * transaction. Another tenant's documents never appear. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {verifyAccessEffectiveCompanyTenant,verificationDifferences} from '../core/access-effective-company-check';
import {getJobDocumentPage,readJobDocument} from '../packs/job-descriptions/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex');
const MODES=['legacy','shadow','precomputed'] as const;
type Mode=typeof MODES[number];

/** The predecessor bodies 7210 restates, as installed (access_workforce_company and access_allowed_for_tenant as 5071
 * re-created them, reading app.access_capability_effective). A change to any of them must change 7210 in the same migration. */
const RESTATED:Record<string,string>={
 'app.access_workforce_company(uuid,text)':'a011dea56573fb9ed6ec42039fd633c482441190f84b7a3fd4ef0a23b76236da',
 'app.access_allowed_for_tenant(uuid,uuid,text,uuid)':'45bd6bc38de30e1c483af3d1b5f1aa2b0399d886832ba0c5ce87a45aa3b20b5a',
 'app.access_scope_covers(uuid,uuid,uuid)':'cdc1e711ad646d29026ab900cd53b1d9d99c710dccbad5c7238651a5a3fb27c1',
 'app.company_org_descendant_for_tenant(uuid,uuid,uuid)':'fe5db167282ceb4c00dbfe9213d784ec9905fbd3c17b432d302e7e4d9bcddcfe',
 'app.company_org_parent_for_tenant(uuid,uuid)':'7739caaa28906ca3087dabd1704564005ab61d202ab682f3baef295d6b12906c',
 'app.grants_have_role_for(jsonb,text,uuid)':'35bb5e05077ee1bbc637de31e0a706e55644be17acc8c711fdcf05d851f2915e',
 'app.has_role_for(text,uuid)':'877f5bbecdf4dacf06661f1a8cd387f10063f395d76ea09f729257aeb1636bde',
 'app.is_company_descendant(uuid,uuid)':'ff727e66b1225c703c53f1e6211cc77cbc8accec7e729884b35e3b4093f8de68',
 'app.job_document_scope(uuid,uuid)':'10ebe4aecc41fb808fe037016219f7335cb97929a2b36e3e30f02c001ab1ba3c',
};
/** The policies 7210 replaced, exactly as 0595 created them (2202 then limited each to ai_hr_app). The revision write
 * policy is FOR ALL, so it also governs reads (and SELECT ... FOR UPDATE). */
const REVISION_WRITE="app.job_document_scope(tenant_id,job_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=job_id AND j.tenant_id=job_document_revision.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain'))";
const OLD_POLICIES={
 job_document_read:{table:'job_document',command:'select',using:"tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.view')",check:null},
 job_document_revision_read:{table:'job_document_revision',command:'select',using:'app.job_document_scope(tenant_id,job_id)',check:null},
 job_document_revision_write:{table:'job_document_revision',command:'all',using:REVISION_WRITE,check:REVISION_WRITE},
} as const;
type PolicyName=keyof typeof OLD_POLICIES;
let newPolicies:Record<PolicyName,{using:string;check:string|null}>;

let b:Base,other:Base,root:string,beta:string,level1:string[],level2:string[],a1:string,a1Children:string[],leaf:string,betaChild:string;
let approverId:string,probeJob:string;
const actors:Record<string,SessionContext>={};
const groupCtx=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]}) as SessionContext;

async function user(role:'hr_admin'|'super_admin'|'employee',companyId:string|null,personId:string|null=null):Promise<SessionContext>{
 const[u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:`fixture_${randomUUID()}`,personId}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role,companyId});
 return{...adminCtx(b),userId:u.id,personId:personId??undefined,roles:[role],grants:[{role,companyId}]} as SessionContext;
}
async function companies(tenantId:string,names:string[],parents:(string|null)[]):Promise<string[]>{
 const rows=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${tenantId}::uuid,n,p from unnest(${names}::text[],${parents}::uuid[]) with ordinality x(n,p,k) order by k returning id`;
 return rows.map(r=>r.id);
}
async function jobs(tenantId:string,companyIds:string[],perCompany:number){
 await owner.client.begin(async tx=>{
  await tx`select set_config('app.user_id',${b.adminUserId},true)`;
  await tx`insert into job_document(tenant_id,company_id,job_code,normalized_code,created_by,updated_at)
   select ${tenantId}::uuid,c.id,'JD-'||c.k||'-'||g,'jd-'||c.k||'-'||g,${tenantId===b.tenantId?b.adminUserId:other.adminUserId}::uuid,now()-((c.k*${perCompany}+g)*interval '1 minute')
   from unnest(${companyIds}::uuid[]) with ordinality c(id,k) cross join generate_series(1,${perCompany}) g`;
  // An approved first version and a working draft for every job: the guard trigger only admits drafts created by
  // their preparer, so the fixture writes the history directly with that one trigger off, in this transaction only.
  await tx`alter table job_document_revision disable trigger job_revision_guard`;
  await tx`insert into job_document_revision(tenant_id,job_id,version,status,title,definition,prepared_by,last_edited_by,approved_by,approved_at,effective_on,review_on)
   select j.tenant_id,j.id,1,'approved','Fictional role '||j.job_code,'{"sections":[]}'::jsonb,j.created_by,j.created_by,${approverId}::uuid,now(),${day(-30)}::date,${day(300)}::date
   from job_document j where j.tenant_id=${tenantId}::uuid`;
  await tx`insert into job_document_revision(tenant_id,job_id,version,status,title,definition,prepared_by,last_edited_by)
   select j.tenant_id,j.id,2,'draft','Fictional role '||j.job_code||' (draft)','{"sections":[]}'::jsonb,j.created_by,j.created_by
   from job_document j where j.tenant_id=${tenantId}::uuid`;
  await tx`alter table job_document_revision enable trigger job_revision_guard`;
 });
}
async function setMode(mode:Mode){await owner.client`select app.access_precompute_set_mode(${mode})`;}
async function usePolicies(kind:'old'|'new'){
 await owner.client.begin(async tx=>{
  for(const name of Object.keys(OLD_POLICIES) as PolicyName[]){
   const old=OLD_POLICIES[name],next=newPolicies[name];
   const using=kind==='old'?old.using:next.using,check=kind==='old'?old.check:next.check;
   await tx.unsafe(`drop policy ${name} on public.${old.table}`);
   await tx.unsafe(`create policy ${name} on public.${old.table} for ${old.command} to ai_hr_app using (${using})${check?` with check (${check})`:''}`);
  }
 });
}
const settle=async<T>(fn:()=>Promise<T>):Promise<T|{error:string}>=>{try{return await fn();}catch(e){return{error:(e as Error).message};}};
type Observation=Awaited<ReturnType<typeof observe>>;
/** Everything the Job descriptions read path discloses to one actor, in its own order. */
async function observe(ctx:SessionContext,companyId:string|null){
 const where=companyId?sql`where j.company_id=${companyId}::uuid`:sql``;
 const raw=await settle(()=>withTenant(ctx,async tx=>{
  const list=(await tx.execute<{id:string}>(sql`select j.id::text as id from job_document j ${where} order by j.updated_at desc,j.id`)).map(r=>r.id);
  const[count]=await tx.execute<{n:number}>(sql`select count(*)::int as n from job_document j ${where}`);
  const revisions=(await tx.execute<{id:string}>(sql`select r.id::text as id from job_document_revision r
   ${companyId?sql`where r.job_id in (select j.id from job_document j where j.company_id=${companyId}::uuid)`:sql``} order by r.job_id,r.version`)).map(r=>r.id);
  return{list,count:count.n,revisions};
 }));
 // Rows locked FOR UPDATE must also pass the UPDATE policies: the maintain side of the revision write policy.
 const lockable=await settle(()=>withTenant(ctx,async tx=>(await tx.execute<{id:string}>(sql`select r.id::text as id from job_document_revision r
  ${companyId?sql`where r.job_id in (select j.id from job_document j where j.company_id=${companyId}::uuid)`:sql``} order by r.job_id,r.version for update of r`)).map(r=>r.id)));
 const filters=companyId?{company:companyId}:{};
 const page=async(p:string)=>settle(async()=>{const r=await getJobDocumentPage(ctx,{...filters,page:p});return{ids:r.rows.map(x=>x.id),total:r.total,page:r.page};});
 const read=await settle(async()=>{const r=await readJobDocument(ctx,probeJob);return{job:r.job.id,revision:r.revision.id,history:r.history.map(h=>h.id)};});
 return{raw,lockable,page1:await page('1'),page2:await page('2'),read};
}
async function observeAll():Promise<Record<string,Observation>>{
 const out:Record<string,Observation>={};
 for(const[label,ctx]of Object.entries(actors))for(const scope of [null,leaf] as const)out[`${label} / ${scope?'one company':'All companies'}`]=await observe(ctx,scope);
 return out;
}
/** Old policies first, then the new policies in every mode: identical observations for every actor and scope. */
async function expectEquivalent(phase:string){
 await usePolicies('old');
 const started=performance.now();const before=await observeAll();const oldMs=performance.now()-started;
 await usePolicies('new');
 const timings:Record<string,number>={old:Math.round(oldMs)};
 for(const mode of MODES){
  await setMode(mode);
  const t=performance.now();const after=await observeAll();timings[mode]=Math.round(performance.now()-t);
  for(const key of Object.keys(before))expect(after[key],`${phase} · ${mode} · ${key}`).toEqual(before[key]);
 }
 await setMode('legacy');
 console.log(`[access-effective-company] ${phase}: ${Object.keys(before).length} observations, ms ${JSON.stringify(timings)}`);
 return before;
}
const listed=(o:Observation)=>'list' in o.raw?o.raw.list.length:-1;
async function unusable(ctx:SessionContext):Promise<string|null>{
 return owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true)`;
  const[r]=await tx<{reason:string|null}[]>`select app.access_effective_company_unusable() as reason`;return r.reason;
 });
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 b=await seedBase();other=await seedBase();root=b.companyId;
 const installed=await owner.client<{name:PolicyName;qual:string;check:string|null}[]>`select policyname as name,qual,with_check as check from pg_policies
  where schemaname='public' and policyname in ('job_document_read','job_document_revision_read','job_document_revision_write') order by 1`;
 expect(installed.map(p=>p.name)).toEqual(['job_document_read','job_document_revision_read','job_document_revision_write']);
 newPolicies=Object.fromEntries(installed.map(p=>[p.name,{using:p.qual,check:p.check}])) as typeof newPolicies;
 // 70 companies: the root, eight children and a second root (Beta), and sixty grandchildren across those nine.
 level1=await companies(b.tenantId,[...Array.from({length:8},(_,i)=>`Fictional A${i+1} Sdn Bhd`),'Fictional Beta Bhd'],[...Array(8).fill(root),null]);
 beta=level1[8];a1=level1[0];
 level2=await companies(b.tenantId,Array.from({length:60},(_,i)=>`Fictional unit ${i+1} Sdn Bhd`),Array.from({length:60},(_,i)=>level1[i%9]));
 a1Children=level2.filter((_,i)=>i%9===0);leaf=a1Children[0];betaChild=level2[8];
 const all=[root,...level1,...level2];expect(all).toHaveLength(70);
 // 1,000 fictional employments spread over the 70 companies.
 await owner.client.unsafe(`with p as (insert into person(tenant_id,full_name,primary_email)
   select $1::uuid,'Fictional EQ '||g,'eq-'||g||'@example.test' from generate_series(1,1000) g returning id),
  n as (select id,row_number() over (order by id) k from p)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select $1::uuid,n.id,($2::uuid[])[1+(n.k % 70)::int],'EQ'||lpad(n.k::text,5,'0'),'2025-01-06' from n`,[b.tenantId,`{${all.join(',')}}`]);
 const approver=await user('hr_admin',null);approverId=approver.userId!;
 await jobs(b.tenantId,all,2);
 await jobs(other.tenantId,[other.companyId],2);
 [{id:probeJob}]=await owner.client<{id:string}[]>`select id::text as id from job_document where company_id=${leaf}::uuid order by id limit 1`;
 // A login-blocked administrator: their only employment ended yesterday.
 const[blockedPerson]=await owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional leaver','eq-leaver@example.test') returning id`;
 await owner.client`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,last_working_date) values(${b.tenantId}::uuid,${blockedPerson.id}::uuid,${root}::uuid,'EQLEAVER','2025-01-06',${day(-1)}::date)`;
 Object.assign(actors,{
  'group administrator':groupCtx(),
  'subtree administrator (A1)':await user('hr_admin',a1),
  'leaf administrator':await user('hr_admin',leaf),
  'second-tree administrator (Beta)':await user('hr_admin',beta),
  'super administrator':await user('super_admin',null),
  'employee':await user('employee',null),
  'claim narrower than grant':{...groupCtx(),grants:[{role:'hr_admin',companyId:a1}]} as SessionContext,
  'claim wider than grant':{...(await user('hr_admin',betaChild)),grants:[{role:'hr_admin',companyId:null}]} as SessionContext,
  'login-blocked administrator':await user('hr_admin',null,blockedPerson.id),
 });
 // Two roles (super_admin is group-wide by constraint): the stored roles must match the session's claims, so claiming
 // only the A1 hr_admin grant narrows the answer to A1's subtree.
 const both=await user('hr_admin',a1);await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:both.userId!,role:'super_admin',companyId:null});
 actors['holder of both roles, claiming both']={...both,roles:['hr_admin','super_admin'],grants:[{role:'hr_admin',companyId:a1},{role:'super_admin',companyId:null}]} as SessionContext;
 actors['holder of both roles, claiming A1 hr only']={...both,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:a1}]} as SessionContext;
 const archived=await user('hr_admin',null);
 await owner.client`update app_user set archived_at=now() where id=${archived.userId!}::uuid`;
 actors['archived administrator']=archived;
},600_000);
afterAll(async()=>{try{await setMode('legacy');await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain')`);}finally{await closeAll();}});

describe('precomputed company access (7210) on Job descriptions',()=>{
 it('pins its predecessors, its policies, its grants and its once-per-statement plan',async()=>{
  const changed:string[]=[];
  for(const[signature,expected]of Object.entries(RESTATED)){
   const[row]=await owner.client<{body:string}[]>`select prosrc as body from pg_proc where oid=${signature}::regprocedure`;
   // Source code only: print what is installed so a changed predecessor can be reviewed against 7210.
   if(sha256(row.body)!==expected){changed.push(signature);console.log(`[access-effective-company] installed ${signature} ${sha256(row.body)}\n${row.body}`);}
  }
  expect(changed).toEqual([]);
  // The reinstated "old" policies are the real predecessors: 0595 created them, 2202 only limited them to ai_hr_app,
  // and no other migration before 7210 touched them.
  const m0595=readFileSync('db/migrations/0595_job_description_documents.sql','utf8');
  expect(m0595).toContain(`CREATE POLICY job_document_read ON job_document FOR SELECT USING(${OLD_POLICIES.job_document_read.using});`);
  expect(m0595).toContain(`CREATE POLICY job_document_revision_read ON job_document_revision FOR SELECT USING(${OLD_POLICIES.job_document_revision_read.using});`);
  expect(m0595).toContain(`CREATE POLICY job_document_revision_write ON job_document_revision FOR ALL USING(${REVISION_WRITE}) WITH CHECK(${REVISION_WRITE});`);
  const touching=readdirSync('db/migrations').filter(f=>f.endsWith('.sql')&&/\bjob_document(_revision)?_(read|write) ON\b/.test(readFileSync(`db/migrations/${f}`,'utf8'))).sort();
  expect(touching).toEqual(['0595_job_description_documents.sql','2202_job_architecture_profile.sql','7210_access_effective_company.sql']);
  for(const p of Object.values(newPolicies))for(const expr of [p.using,p.check].filter(Boolean) as string[]){expect(expr).toContain('access_workforce_companies');expect(expr).not.toMatch(/access_workforce_company\(|job_document_scope/);}
  const roles=await owner.client<{policyname:string;cmd:string;roles:string[]}[]>`select policyname,cmd,roles::text[] as roles from pg_policies where policyname in ('job_document_read','job_document_revision_read','job_document_revision_write') order by 1`;
  expect(roles).toEqual([{policyname:'job_document_read',cmd:'SELECT',roles:['ai_hr_app']},{policyname:'job_document_revision_read',cmd:'SELECT',roles:['ai_hr_app']},{policyname:'job_document_revision_write',cmd:'ALL',roles:['ai_hr_app']}]);
  // ai_hr_app reaches the stored answer only through the read function.
  const tables=await owner.client<{name:string;app:boolean;rls:boolean;forced:boolean;policies:number}[]>`select c.relname as name,
   has_table_privilege('ai_hr_app',c.oid,'select,insert,update,delete') as app,c.relrowsecurity as rls,c.relforcerowsecurity as forced,
   (select count(*)::int from pg_policy p where p.polrelid=c.oid) as policies
   from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ('access_company_closure','access_effective_company','access_company_state','access_precompute_control') order by 1`;
  expect(tables).toEqual(['access_company_closure','access_company_state','access_effective_company','access_precompute_control'].map(name=>({name,app:false,rls:true,forced:true,policies:1})));
  const fns=await owner.client<{name:string;app:boolean}[]>`select p.proname as name,has_function_privilege('ai_hr_app',p.oid,'execute') as app
   from pg_proc p where p.pronamespace='app'::regnamespace and (p.proname like 'access_effective_company%' or p.proname in ('access_company_closure_compute','access_workforce_companies','access_precompute_set_mode')) order by 1`;
  expect(fns.filter(f=>f.app).map(f=>f.name)).toEqual(['access_workforce_companies']);
  expect(fns.length).toBeGreaterThanOrEqual(12);
  const[mode]=await owner.client<{mode:string}[]>`select mode from access_precompute_control`;expect(mode.mode).toBe('legacy');
  // One evaluation per statement: the company set is an InitPlan, never a per-row access_workforce_company call.
  for(const m of MODES){
   await setMode(m);
   const plan=await withTenant(groupCtx(),tx=>tx.execute<{'QUERY PLAN':string}>(sql`explain (verbose,costs off) select r.id from job_document_revision r`));
   const text=plan.map(r=>r['QUERY PLAN']).join('\n');
   expect(text,m).toMatch(/InitPlan[\s\S]*access_workforce_companies/);expect(text,m).not.toMatch(/access_workforce_company\(/);expect(text,m).not.toContain('job_document_scope');
  }
  await setMode('legacy');
  // The trigger-maintained state is complete for the fixture tenant and verifies clean.
  const v=await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId);
  expect(v).toMatchObject({windowRefreshed:false,trusted:true});expect(verificationDifferences(v)).toBe(0);
  const[closure]=await owner.client<{n:number}[]>`select count(*)::int as n from access_company_closure where tenant_id=${b.tenantId}::uuid and ancestor_id=descendant_id`;
  expect(closure.n).toBe(70);
 },600_000);

 it('returns identical rows, order and counts for every actor with the capability unsupported',async()=>{
  const seen=await expectEquivalent('capability unsupported');
  // Not vacuous, and checked against independent expectations.
  expect(listed(seen['group administrator / All companies'])).toBe(140);
  expect(listed(seen['subtree administrator (A1) / All companies'])).toBe(2*(1+a1Children.length));
  expect(listed(seen['claim narrower than grant / All companies'])).toBe(2*(1+a1Children.length));
  expect(listed(seen['leaf administrator / All companies'])).toBe(2);
  expect(listed(seen['second-tree administrator (Beta) / All companies'])).toBe(2*(1+level2.filter((_,i)=>i%9===8).length));
  expect(listed(seen['holder of both roles, claiming both / All companies'])).toBe(140);
  expect(listed(seen['holder of both roles, claiming A1 hr only / All companies'])).toBe(2*(1+a1Children.length));
  expect(listed(seen['super administrator / All companies'])).toBe(140);
  for(const none of ['employee','claim wider than grant','login-blocked administrator','archived administrator'])expect(listed(seen[`${none} / All companies`]),none).toBe(0);
  expect(listed(seen['group administrator / one company'])).toBe(2);
  const page=seen['group administrator / All companies'].page2 as {ids:string[];total:number};
  expect(page.total).toBe(140);expect(page.ids).toHaveLength(50);
  const raw=seen['group administrator / All companies'].raw as {revisions:string[]};
  expect(raw.revisions).toHaveLength(280);
  const read=seen['group administrator / All companies'].read as {history:string[]};
  expect(read.history).toHaveLength(2);
  expect(seen['second-tree administrator (Beta) / All companies'].read).toEqual({error:'Job record not available'});
 },900_000);

 it('stays identical with the capability enforced and after an explicit deny saved through the access editor',async()=>{
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`);
  const enforced=await expectEquivalent('capability enforced');
  const actor=groupCtx(),before=await withTenant(actor,tx=>accessConfigurationStore.loadCurrent(tx,actor));
  const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId:b.adminUserId,capabilityId:'workforce.view',companyId:a1,effect:'deny' as const}};
  const preview=await previewAccessConfiguration(actor,edit,accessConfigurationStore);
  await saveAccessConfiguration(actor,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
  const denied=await expectEquivalent('explicit deny on the A1 subtree');
  expect(listed(denied['group administrator / All companies'])).toBe(listed(enforced['group administrator / All companies'])-2*(1+a1Children.length));
  expect(listed(denied['group administrator / one company'])).toBe(0);
  const v=await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId);expect(verificationDifferences(v)).toBe(0);
 },900_000);

 it('honours a future-dated restructure the day before and on its effective day',async()=>{
  const[run]=await owner.client<{id:string}[]>`insert into company_organisation_run(tenant_id,kind,effective_on,state,company_ids,authority_company_ids,mapping,source_epoch,digest,requested_by,published_at)
   values(${b.tenantId}::uuid,'restructure',${day(1)}::date,'published',${`{${a1}}`}::uuid[],${`{${a1}}`}::uuid[],'{}'::jsonb,0,'fictional-restructure',${b.adminUserId}::uuid,now()) returning id`;
  await owner.client`insert into company_organisation_mapping(run_id,tenant_id,company_id,parent_company_id) values(${run.id}::uuid,${b.tenantId}::uuid,${a1}::uuid,${beta}::uuid)`;
  const[state]=await owner.client<{until:string}[]>`select valid_until::text as until from access_company_state where tenant_id=${b.tenantId}::uuid`;
  expect(state.until).toBe(day(1));
  expect(await unusable(actors['group administrator'])).toBeNull();
  const dayBefore=await expectEquivalent('restructure published, effective tomorrow');
  // The effective day, without a write: the run takes effect today and the stored closure was computed yesterday.
  await owner.client.begin(async tx=>{
   await tx`alter table company_organisation_run disable trigger user`;
   await tx`update company_organisation_run set effective_on=${day(0)}::date where id=${run.id}::uuid`;
   await tx`alter table company_organisation_run enable trigger user`;
   await tx`update access_company_state set computed_for=${day(-1)}::date,valid_until=${day(0)}::date where tenant_id=${b.tenantId}::uuid`;
  });
  expect(await unusable(actors['group administrator'])).toBe('outside_window');
  const effective=await expectEquivalent('restructure effective today, stored answer outside its window');
  expect(listed(effective['second-tree administrator (Beta) / All companies'])).toBe(listed(dayBefore['second-tree administrator (Beta) / All companies'])+2*(1+a1Children.length));
  // The scheduled check recomputes the expired window; it is not a difference, and the stored answer is used again.
  const v=await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId);
  expect(v).toMatchObject({windowRefreshed:true,trusted:true});expect(verificationDifferences(v)).toBe(0);
  expect(await unusable(actors['group administrator'])).toBeNull();
  await expectEquivalent('restructure effective today, window recomputed');
 },900_000);

 it('fails closed to the legacy answer when a writer bypassed maintenance, and logs counts only in shadow',async()=>{
  const missed=await user('employee',null);
  // Separate statements: a table with pending trigger events cannot be altered in the same transaction.
  await owner.client`alter table role_assignment disable trigger access_effective_company_insert`;
  try{await owner.client`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${b.tenantId}::uuid,${missed.userId!}::uuid,'hr_admin',null)`;}
  finally{await owner.client`alter table role_assignment enable trigger access_effective_company_insert`;}
  actors['administrator added by a bypassing writer']={...missed,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:null}]} as SessionContext;
  // Shadow serves the legacy answer and reports the difference as counts, with no identifier.
  const notices:string[]=[];
  const listen=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:1,onnotice:n=>notices.push(String(n.message))});
  try{
   await setMode('shadow');
   const served=await listen.begin(async tx=>{
    await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${missed.userId!},true),set_config('app.roles','employee,hr_admin',true),
     set_config('app.grants',${JSON.stringify([{role:'employee',companyId:null},{role:'hr_admin',companyId:null}])},true),set_config('client_min_messages','log',true)`;
    const[r]=await tx<{n:number}[]>`select cardinality(app.access_workforce_companies('workforce.view')) as n`;return r.n;
   });
   expect(served).toBeGreaterThan(0);
   const line=notices.find(n=>n.startsWith('access_effective_company shadow'));
   expect(line).toMatch(/^access_effective_company shadow capability=workforce\.view missing=[1-9]\d* extra=0 reason=compared$/);
   expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  }finally{await listen.end();await setMode('legacy');}
  const v=await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId);
  expect(v.rowsMissing).toBeGreaterThan(0);expect(v.trusted).toBe(false);
  expect(await unusable(actors['group administrator'])).toBe('untrusted');
  const untrusted=await expectEquivalent('missed writer, tenant untrusted');
  expect(listed(untrusted['administrator added by a bypassing writer / All companies'])).toBeGreaterThan(0);
  // The next check still reports it, until an operator re-trusts the tenant.
  expect((await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId)).trusted).toBe(false);
  await owner.client`select app.access_effective_company_retrust(${b.tenantId}::uuid)`;
  expect(await unusable(actors['group administrator'])).toBeNull();
  const v2=await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId);expect(verificationDifferences(v2)).toBe(0);expect(v2.trusted).toBe(true);
  await expectEquivalent('re-trusted after repair');
 },900_000);

 it('maintains the stored answer in the same transaction as the access change',async()=>{
  // Unsupported again (the capability trigger recomputes every tenant), so the expected set is the role scope alone.
  await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain')`);
  await setMode('precomputed');
  try{
   const[u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:`fixture_${randomUUID()}`}).returning({id:s.appUser.id});
   const result=await owner.client.begin(async tx=>{
    await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${u.id},true),set_config('app.roles','',true),set_config('app.grants','[]',true)`;
    const[before]=await tx<{v:string[];version:string}[]>`select app.access_workforce_companies('workforce.view')::text[] as v,(select access_version::text from access_company_state where tenant_id=${b.tenantId}::uuid) as version`;
    await tx`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${b.tenantId}::uuid,${u.id}::uuid,'hr_admin',${a1}::uuid)`;
    await tx`select set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:a1}])},true)`;
    const[after]=await tx<{v:string[];legacy:string[];reason:string|null;version:string}[]>`select app.access_workforce_companies('workforce.view')::text[] as v,
     coalesce((select array_agg(c.id::text order by c.id) from company c where c.tenant_id=${b.tenantId}::uuid and app.access_workforce_company(c.id,'workforce.view')),'{}') as legacy,
     app.access_effective_company_unusable() as reason,(select access_version::text from access_company_state where tenant_id=${b.tenantId}::uuid) as version`;
    return{before,after};
   });
   expect(result.before.v).toEqual([]);
   expect(result.after.reason).toBeNull();
   expect(result.after.v).toEqual(result.after.legacy);
   expect([...result.after.v].sort()).toEqual([a1,...a1Children].sort());
   expect(BigInt(result.after.version)).toBeGreaterThan(BigInt(result.before.version));
  }finally{await setMode('legacy');}
 },600_000);
});
