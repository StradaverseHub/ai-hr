/** Admin > Organisation active headcount, answered once per company (ADR 0181 addendum on employment visibility,
 * section 9, step (a)).
 *
 * The previous statement asked two company-level questions per employment row: app.is_admin_for(company_id) and
 * app.access_workforce_employment(id,'workforce.view'). core/company-registration-readiness.ts companyActiveHeadcounts
 * now asks them once per company (is_admin_for over the tenant's companies; app.access_workforce_companies from 7210)
 * and writes out the rest of access_workforce_employment (same tenant, not voided, import condition). This test runs
 * the PREVIOUS statement verbatim and the new function side by side on the 7210 pilot fixture (70 companies,
 * 1,000 employments, the same actors), plus a voided and an import-pending employment, in every 7210 mode, with the
 * capability unsupported, enforced, and with an explicit deny saved through the access editor, with and without the
 * matching import-attempt setting. Results must be identical and non-vacuous, and the new plan must not call
 * access_workforce_employment at all. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {employment} from '../db/schema';
import {companyActiveHeadcounts,companyActiveHeadcountsQuery} from '../core/company-registration-readiness';
import {employmentStatusSql} from '../core/employment-status-sql';
import {todayInKualaLumpur} from '../lib/hr-date';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {owner} from './harness';
import {MODES,a1,a1Children,actors,b,buildFixture,groupCtx,leaf,other,setMode,teardownFixture} from './access-effective-company-fixture';

type Counts={companyId:string;count:number}[];
let companyIds:string[]=[];
const pendingAttempt=randomUUID();

beforeAll(async()=>{
 await buildFixture();
 // A voided employment and an import-pending employment in the leaf company (fictional; written as the storage owner).
 const people=await owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email)
  select ${b.tenantId}::uuid,'Fictional headcount '||g,'hc-'||g||'@example.test' from generate_series(1,2) g returning id`;
 await owner.client`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,voided_at,voided_by,void_reason,voided_import_attempt_id,voided_employee_code)
  values(${b.tenantId}::uuid,${people[0].id}::uuid,${leaf}::uuid,null,'2025-01-06',now(),${b.adminUserId}::uuid,'Fictional void',${randomUUID()}::uuid,'HCVOID')`;
 await owner.client`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,import_pending_attempt_id)
  values(${b.tenantId}::uuid,${people[1].id}::uuid,${leaf}::uuid,'HCPENDING','2025-01-06',${pendingAttempt}::uuid)`;
 // Every company of the fixture tenant, plus the other tenant's company (which must never count).
 companyIds=[...(await owner.client<{id:string}[]>`select id::text as id from company where tenant_id=${b.tenantId}::uuid order by id`).map(r=>r.id),other.companyId];
 actors['payroll partner claim']={...groupCtx(),grants:[{role:'payroll_partner',companyId:null}]} as SessionContext;
},600_000);
afterAll(teardownFixture);

const sorted=(rows:Counts)=>[...rows].map(r=>({companyId:String(r.companyId),count:Number(r.count)})).sort((x,y)=>x.companyId.localeCompare(y.companyId));
const settle=async(fn:()=>Promise<Counts>)=>{try{return sorted(await fn());}catch(e){return{error:(e as Error).message};}};
const importSetting=async(tx:Tx,on:boolean)=>{if(on)await tx.execute(sql`select set_config('app.import_attempt',${pendingAttempt},true)`);};

/** The statement as it was before this change, verbatim. */
const previous=(ctx:SessionContext,importOn:boolean)=>settle(()=>withTenant(ctx,async tx=>{
 await importSetting(tx,importOn);
 return tx.select({companyId:employment.companyId,count:sql<number>`count(distinct ${employment.id})::int`}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),inArray(employment.companyId,companyIds),sql`app.is_admin_for(${employment.companyId})`,sql`app.access_workforce_employment(${employment.id},'workforce.view')`,sql`${employment.hiredOn}<=${todayInKualaLumpur()}::date`,sql`${employmentStatusSql()} in ('active','probation','active_serving_notice')`)).groupBy(employment.companyId);
}));
const current=(ctx:SessionContext,importOn:boolean)=>settle(()=>withTenant(ctx,async tx=>{
 await importSetting(tx,importOn);
 return companyActiveHeadcounts(tx,ctx.tenantId,companyIds);
}));
const total=(r:Counts|{error:string})=>'error' in r?-1:r.reduce((n,x)=>n+x.count,0);

async function expectEquivalent(phase:string){
 const seen:Record<string,Counts|{error:string}>={};
 const timings:Record<string,number>={old:0};
 for(const importOn of [false,true])for(const[label,ctx]of Object.entries(actors)){
  const t=performance.now();seen[`${label} / import ${importOn?'on':'off'}`]=await previous(ctx,importOn);timings.old+=performance.now()-t;
 }
 for(const mode of MODES){
  await setMode(mode);timings[mode]=0;
  for(const importOn of [false,true])for(const[label,ctx]of Object.entries(actors)){
   const key=`${label} / import ${importOn?'on':'off'}`;
   const t=performance.now();const after=await current(ctx,importOn);timings[mode]+=performance.now()-t;
   expect(after,`${phase} · ${mode} · ${key}`).toEqual(seen[key]);
  }
 }
 await setMode('legacy');
 console.log(`[company-headcount] ${phase}: ${Object.keys(seen).length} observations, ms ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,Math.round(v)])))}`);
 return seen;
}

describe('Admin > Organisation headcount, once per company',()=>{
 it('never calls access_workforce_employment and evaluates the company sets once per statement',async()=>{
  for(const mode of MODES){
   await setMode(mode);
   const text=(await withTenant(groupCtx(),tx=>tx.execute<{'QUERY PLAN':string}>(sql`explain (verbose,costs off) ${companyActiveHeadcountsQuery(tx,b.tenantId,companyIds)}`))).map(r=>r['QUERY PLAN']).join('\n');
   expect(text,mode).toMatch(/InitPlan[\s\S]*access_workforce_companies/);
   expect(text,mode).toMatch(/InitPlan[\s\S]*is_admin_for\(c\.id\)/);
   expect(text,mode).not.toContain('access_workforce_employment');
  }
  await setMode('legacy');
 },600_000);

 it('returns identical counts for every actor with the capability unsupported',async()=>{
  const seen=await expectEquivalent('capability unsupported');
  // Not vacuous, against independent expectations: the fixture's 1,000 employments are all hired in 2025 and current.
  const group=seen['group administrator / import off'] as Counts;
  expect(total(group)).toBeGreaterThanOrEqual(1000);
  expect(group.some(r=>r.companyId===other.companyId)).toBe(false);
  const subtree=seen['subtree administrator (A1) / import off'] as Counts;
  expect(new Set(subtree.map(r=>r.companyId))).toEqual(new Set([a1,...a1Children].filter(id=>group.some(r=>r.companyId===id))));
  expect(subtree).toEqual(group.filter(r=>[a1,...a1Children].includes(r.companyId)));
  const leafCount=(k:string)=>((seen[k] as Counts).find(r=>r.companyId===leaf)?.count??0);
  // The import-pending employment counts only inside its own attempt; the voided one never does.
  expect(leafCount('leaf administrator / import on')).toBe(leafCount('leaf administrator / import off')+1);
  for(const none of ['employee','claim wider than grant','payroll partner claim'])expect(total(seen[`${none} / import off`]),none).toBe(0);
 },900_000);

 it('stays identical with the capability enforced and after an explicit deny saved through the access editor',async()=>{
  await owner.client`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`;
  const enforced=await expectEquivalent('capability enforced');
  const actor=groupCtx(),before=await withTenant(actor,tx=>accessConfigurationStore.loadCurrent(tx,actor));
  const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId:b.adminUserId,capabilityId:'workforce.view',companyId:a1,effect:'deny' as const}};
  const preview=await previewAccessConfiguration(actor,edit,accessConfigurationStore);
  await saveAccessConfiguration(actor,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
  const denied=await expectEquivalent('explicit deny on the A1 subtree');
  const subtreeTotal=total((enforced['group administrator / import off'] as Counts).filter(r=>[a1,...a1Children].includes(r.companyId)) as Counts);
  expect(subtreeTotal).toBeGreaterThan(0);
  expect(total(denied['group administrator / import off'])).toBe(total(enforced['group administrator / import off'])-subtreeTotal);
 },900_000);
});
