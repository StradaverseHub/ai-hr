/** ADR 0181 Phase 2 pilot (migration 7210): precomputed company access on the Job descriptions read path.
 *
 * Equivalence (docs/adr/0181-addendum-precomputed-company-access.md section 7), on the fixture in
 * test/access-effective-company-fixture.ts: the PREVIOUS policies (the exact 0595 text, reinstated by the test) and the
 * 7210 policies in each mode ('legacy', 'shadow', 'precomputed') return identical rows, order and counts for every
 * actor, under "All companies" and one company: the raw list, count, revision history and revisions lockable for
 * update, the Job descriptions page (both pages, with its total) and the document read. Actors cover group, subtree,
 * leaf and second-tree administrators, a super administrator, a holder of both roles (claiming both or one), an
 * employee, a session claim narrower than the grant, a claim wider than the grant, an archived and a login-blocked
 * administrator. Phases here: capability unsupported, capability enforced, an explicit deny saved through the real
 * access editor, and maintenance visible in the same transaction. The date window and the bypassing writer are in
 * test/access-effective-company-maintenance.test.ts. Another tenant's documents never appear. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {verifyAccessEffectiveCompanyTenant,verificationDifferences} from '../core/access-effective-company-check';
import {owner} from './harness';
import {MODES,OLD_POLICIES,RESTATED,REVISION_WRITE,a1,a1Children,b,buildFixture,expectEquivalent,groupCtx,leaf,level2,listed,newPolicies,setMode,sha256,teardownFixture} from './access-effective-company-fixture';

beforeAll(buildFixture,600_000);
afterAll(teardownFixture);

describe('precomputed company access (7210) on Job descriptions: equivalence',()=>{
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
