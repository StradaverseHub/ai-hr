/** Shared fixture and observation helpers for the 7210 pilot tests (test/access-effective-company-equivalence.test.ts
 * and test/access-effective-company-maintenance.test.ts): a fictional group of 70 companies in a three-level tree,
 * 1,000 employments, 140 Job descriptions and 280 revisions, another tenant, the actors, and the comparison of the
 * previous policies (reinstated verbatim) with the 7210 policies in each mode. Each test file runs in its own worker
 * database. */
import {expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {getJobDocumentPage,readJobDocument} from '../packs/job-descriptions/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

export const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
export const sha256=(text:string)=>createHash('sha256').update(text).digest('hex');
export const MODES=['legacy','shadow','precomputed'] as const;
export type Mode=typeof MODES[number];

/** The predecessor bodies 7210 restates, as installed (access_workforce_company and access_allowed_for_tenant as 5071
 * re-created them, reading app.access_capability_effective). A change to any of them must change 7210 in the same migration. */
export const RESTATED:Record<string,string>={
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
export const REVISION_WRITE="app.job_document_scope(tenant_id,job_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=job_id AND j.tenant_id=job_document_revision.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain'))";
export const OLD_POLICIES={
 job_document_read:{table:'job_document',command:'select',using:"tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.view')",check:null},
 job_document_revision_read:{table:'job_document_revision',command:'select',using:'app.job_document_scope(tenant_id,job_id)',check:null},
 job_document_revision_write:{table:'job_document_revision',command:'all',using:REVISION_WRITE,check:REVISION_WRITE},
} as const;
export type PolicyName=keyof typeof OLD_POLICIES;
export let newPolicies:Record<PolicyName,{using:string;check:string|null}>;

export let b:Base,other:Base,root:string,beta:string,level1:string[],level2:string[],a1:string,a1Children:string[],leaf:string,betaChild:string;
export let approverId:string,probeJob:string;
export const actors:Record<string,SessionContext>={};
export const groupCtx=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]}) as SessionContext;

export async function user(role:'hr_admin'|'super_admin'|'employee',companyId:string|null,personId:string|null=null):Promise<SessionContext>{
 const[u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:`fixture_${randomUUID()}`,personId}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role,companyId});
 return{...adminCtx(b),userId:u.id,personId:personId??undefined,roles:[role],grants:[{role,companyId}]} as SessionContext;
}
export async function companies(tenantId:string,names:string[],parents:(string|null)[]):Promise<string[]>{
 const rows=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${tenantId}::uuid,n,p from unnest(${names}::text[],${parents}::uuid[]) with ordinality x(n,p,k) order by k returning id`;
 return rows.map(r=>r.id);
}
export async function jobs(tenantId:string,companyIds:string[],perCompany:number){
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
export async function setMode(mode:Mode){await owner.client`select app.access_precompute_set_mode(${mode})`;}
export async function usePolicies(kind:'old'|'new'){
 await owner.client.begin(async tx=>{
  for(const name of Object.keys(OLD_POLICIES) as PolicyName[]){
   const old=OLD_POLICIES[name],next=newPolicies[name];
   const using=kind==='old'?old.using:next.using,check=kind==='old'?old.check:next.check;
   await tx.unsafe(`drop policy ${name} on public.${old.table}`);
   await tx.unsafe(`create policy ${name} on public.${old.table} for ${old.command} to ai_hr_app using (${using})${check?` with check (${check})`:''}`);
  }
 });
}
export const settle=async<T>(fn:()=>Promise<T>):Promise<T|{error:string}>=>{try{return await fn();}catch(e){return{error:(e as Error).message};}};
export type Observation=Awaited<ReturnType<typeof observe>>;
/** Everything the Job descriptions read path discloses to one actor, in its own order. */
export async function observe(ctx:SessionContext,companyId:string|null){
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
export async function observeAll():Promise<Record<string,Observation>>{
 const out:Record<string,Observation>={};
 for(const[label,ctx]of Object.entries(actors))for(const scope of [null,leaf] as const)out[`${label} / ${scope?'one company':'All companies'}`]=await observe(ctx,scope);
 return out;
}
/** Old policies first, then the new policies in every mode: identical observations for every actor and scope. */
export async function expectEquivalent(phase:string,modes:readonly Mode[]=MODES){
 await usePolicies('old');
 const started=performance.now();const before=await observeAll();const oldMs=performance.now()-started;
 await usePolicies('new');
 const timings:Record<string,number>={old:Math.round(oldMs)};
 for(const mode of modes){
  await setMode(mode);
  const t=performance.now();const after=await observeAll();timings[mode]=Math.round(performance.now()-t);
  for(const key of Object.keys(before))expect(after[key],`${phase} · ${mode} · ${key}`).toEqual(before[key]);
 }
 await setMode('legacy');
 console.log(`[access-effective-company] ${phase}: ${Object.keys(before).length} observations, ms ${JSON.stringify(timings)}`);
 return before;
}
export const listed=(o:Observation)=>'list' in o.raw?o.raw.list.length:-1;
export async function unusable(ctx:SessionContext):Promise<string|null>{
 return owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true)`;
  const[r]=await tx<{reason:string|null}[]>`select app.access_effective_company_unusable() as reason`;return r.reason;
 });
}

export async function buildFixture(){
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
}
export async function teardownFixture(){try{await setMode('legacy');await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain')`);}finally{await closeAll();}}
