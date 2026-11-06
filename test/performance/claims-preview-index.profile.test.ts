/** Disposable hosted diagnostic for the native Claims preview and an alternate SQL shape. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../../db/client';
import {assignment,company,department,employment,person} from '../../db/schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {addDaysIso} from '../../lib/roster-month';
import {createClaimType,pendingClaimTaskMetadata,pendingClaimTaskSummary} from '../../packs/claims/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';

const file='test/performance/claims-preview-index.profile.test.ts';
const selection:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selection)&&selection.length===1&&selection[0]===file;
const denseSubjects=128;
const pendingPerSubject=32;
const retainedPerSubject=768;
const limit=25;

beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('compares native lateral and tenant-first Claims previews under application RLS',async()=>{
 const evidenceDir=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
 if(!evidenceDir)throw Error('Focused evidence directory is required');
 const samples:unknown[]=[],writes:unknown[]=[];
 const report:Record<string,unknown>={
  kind:'CLAIMS_PREVIEW_INDEX_AB_COMPONENT_ONLY',
  releaseEligible:false,
  fixture:{denseSubjects,sparseSubjects:1,foreignSubjects:1,pendingPerSubject,retainedPerSubject},
  limitations:'Static fictional rows and a single reader. SQL timings reuse exact fixture-specific native authority outside the measured read. Insert WAL probes use the owner and roll back; they are not application CRUD timings.',
  samples,writes,
 };
 const save=()=>writeFileSync(join(evidenceDir,'claims-preview-index.json'),JSON.stringify(report,null,2));
 await resetDb();
 const base=await seedBase(),foreign=await seedBase(),ctx=adminCtx(base);
 const date=addDaysIso(todayInKualaLumpur(),-180),hireDate=addDaysIso(date,-365);
 const [sparseCompany]=await owner.db.insert(company).values({tenantId:base.tenantId,legalName:'Fictional sparse Claims company'}).returning({id:company.id});
 const [sparseDepartment]=await owner.db.insert(department).values({tenantId:base.tenantId,companyId:sparseCompany.id,name:'Fictional sparse Claims department'}).returning({id:department.id});
 async function seedSubjects(tenantId:string,companyId:string,departmentId:string,size:number){
  const subjects=Array.from({length:size},()=>({id:randomUUID(),personId:randomUUID()}));
  await owner.db.insert(person).values(subjects.map(({personId})=>({
   id:personId,tenantId,fullName:'Fictional Claims index applicant',primaryEmail:personId+'@example.invalid',
  })));
  await owner.db.insert(employment).values(subjects.map(({id,personId})=>({id,personId,tenantId,companyId,hiredOn:hireDate})));
  await owner.db.insert(assignment).values(subjects.map(({id})=>({
   tenantId,employmentId:id,companyId,departmentId,employmentType:'full_time' as const,validFrom:hireDate,
  })));
  return subjects.map(({id})=>id);
 }
 const dense=await seedSubjects(base.tenantId,base.companyId,base.deptA,denseSubjects);
 const sparse=await seedSubjects(base.tenantId,sparseCompany.id,sparseDepartment.id,1);
 const excluded=await seedSubjects(foreign.tenantId,foreign.companyId,foreign.deptA,1);
 const createType=(context:typeof ctx)=>createClaimType(context,{
  code:'PREVIEW_INDEX',name:'Fictional preview index',requiresReceipt:false,defaultTaxable:false,
 });
 const type=await createType(ctx),foreignType=await createType(adminCtx(foreign));
 type SeededClaim={id:string;employmentId:string};
 async function seedClaims(tenantId:string,typeId:string,subjects:string[],createdDate:string){
  await owner.client`insert into public.claim_request
   (tenant_id,employment_id,claim_type_id,amount,incurred_on,status)
   select ${tenantId}::uuid,subject.id,${typeId}::uuid,1,${date}::date,'rejected'
   from unnest(${subjects}::uuid[]) subject(id) cross join generate_series(1,${retainedPerSubject}::integer)`;
  return owner.client<SeededClaim[]>`insert into public.claim_request
   (tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
   select ${tenantId}::uuid,subject.id,${typeId}::uuid,1,${date}::date,'pending',${createdDate}::date
   from unnest(${subjects}::uuid[]) subject(id) cross join generate_series(1,${pendingPerSubject}::integer)
   returning id,employment_id as "employmentId"`;
 }
 // Each cohort ties on timestamp, making the ID tiebreaker observable. The foreign cohort is newest.
 const denseClaims=await seedClaims(base.tenantId,type.id,dense,date);
 const sparseClaims=await seedClaims(base.tenantId,type.id,sparse,addDaysIso(date,-1));
 const foreignClaims=await seedClaims(foreign.tenantId,foreignType.id,excluded,addDaysIso(date,1));
 for(const table of ['claim_request','person','employment','assignment'])await owner.client.unsafe('analyze public.'+table);
 const [count]=await owner.client<{total:number;pending:number}[]>`select count(*)::int as total,
  count(*) filter(where status='pending')::int as pending from public.claim_request`;
 expect(count).toEqual({total:(denseSubjects+2)*(pendingPerSubject+retainedPerSubject),pending:(denseSubjects+2)*pendingPerSubject});
 report.counts=count;
 save();

 const scopes=[
  {name:'dense',companies:[base.companyId,sparseCompany.id,foreign.companyId],subjects:[...dense,...sparse],claims:[...denseClaims,...sparseClaims]},
  {name:'sparse',companies:[sparseCompany.id,foreign.companyId],subjects:sparse,claims:sparseClaims},
 ];
 const newestFixtureIds=(subjects:string[])=>[denseClaims,sparseClaims].flatMap(cohort=>cohort
  .filter(row=>subjects.includes(row.employmentId)).map(row=>row.id).sort()).slice(0,limit);
 for(const scope of scopes){
  const actual=await pendingClaimTaskMetadata(ctx,scope.companies);
  expect(new Set(actual.map(row=>row.employmentId))).toEqual(new Set(scope.subjects));
  expect(new Set(actual.map(row=>row.id))).toEqual(new Set(scope.claims.map(row=>row.id)));
  const expected=newestFixtureIds(scope.subjects);
  const full=await pendingClaimTaskSummary(ctx,scope.companies,limit);
  expect(full.items.map(row=>row.id)).toEqual(expected);
  expect(full.total).toBe(scope.claims.length);
  expect(foreignClaims.every(row=>!expected.includes(row.id))).toBe(true);
 }

 async function measure(phase:string){
  for(const scope of scopes){
   const endToEndStarted=performance.now();
   const native=await pendingClaimTaskSummary(ctx,scope.companies,limit);
   const nativeOwnerMs=performance.now()-endToEndStarted;
   const expected=newestFixtureIds(scope.subjects);
   expect(native.items.map(row=>row.id)).toEqual(expected);
   expect(native.total).toBe(scope.claims.length);
   const results=await withTenant(ctx,async tx=>{
    await tx.execute(sql`set local jit=off`);
    const [identity]=await tx.execute<{role:string}>(sql`select current_user as role`);
    expect(identity.role).toBe('ai_hr_app');
    const subjects=sql.join(scope.subjects.map(id=>sql`(${id}::uuid)`),sql`, `);
    const subjectIds=sql`array[${sql.join(scope.subjects.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
    const where=sql`q.tenant_id=${ctx.tenantId}::uuid and q.status='pending'`;
    const [total]=await tx.execute<{total:number}>(sql`select count(*)::int as total from public.claim_request q
     where ${where} and q.employment_id=any(${subjectIds})`);
    expect(total.total).toBe(native.total);
    const lateral=sql`select h.id,h.employment_id,h.created_at
     from (values ${subjects}) as scope(employment_id)
     join lateral (
      select q.id,q.employment_id,q.created_at from public.claim_request q
      where ${where} and q.employment_id=scope.employment_id
      order by q.created_at desc,q.id limit ${limit}
     ) h on true order by h.created_at desc,h.id limit ${limit}`;
    const global=sql`select q.id,q.employment_id,q.created_at from public.claim_request q
     where ${where} and q.employment_id=any(${subjectIds})
     order by q.created_at desc,q.id limit ${limit}`;
    const shapes=phase.endsWith('repeat')?{global,lateral}:{lateral,global};
    const result=[];
    for(const [shape,query] of Object.entries(shapes)){
     const timesMs:number[]=[];
     for(let iteration=0;iteration<5;iteration++){
      const started=performance.now();
      const rows=await tx.execute<{id:string}>(query);
      timesMs.push(performance.now()-started);
      expect(rows.map(row=>row.id)).toEqual(expected);
     }
     const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`));
     result.push({shape,timesMs,medianMs:[...timesMs].sort((a,b)=>a-b)[2],plan});
    }
    return result;
   },{readOnlySnapshot:true});
   samples.push({phase,scope:scope.name,nativeOwnerMs,exactTotal:native.total,rows:expected.length,results});
   save();
  }
 }

 const rolledBack=Error('Rollback synthetic insert probe');
 async function measureInsert(phase:string){
  let plan:unknown;
  try{
   await owner.client.begin(async tx=>{
    plan=Array.from(await tx`explain(analyze,buffers,wal,format json) insert into public.claim_request
     (tenant_id,employment_id,claim_type_id,amount,incurred_on,status)
     select ${base.tenantId}::uuid,${dense[0]}::uuid,${type.id}::uuid,1,${date}::date,'pending'
     from generate_series(1,256)`);
    throw rolledBack;
   });
  }catch(error){if(error!==rolledBack)throw error;}
  expect(plan).toBeDefined();
  writes.push({phase,rows:256,plan});
  save();
 }

 await measure('baseline');
 const started=performance.now();
 await owner.client`create index performance_claim_preview_global_ab on public.claim_request
  (tenant_id,created_at desc,id) include (employment_id) where status='pending'`;
 try{
  report.indexBuildMs=performance.now()-started;
  const [size]=await owner.client<{bytes:number}[]>`select pg_relation_size('public.performance_claim_preview_global_ab')::int as bytes`;
  report.indexBytes=size.bytes;
  await measure('candidate');
  await measure('candidate-repeat');
  await measureInsert('candidate');
 }finally{
  await owner.client`drop index public.performance_claim_preview_global_ab`;
 }
 await measure('baseline-repeat');
 await measureInsert('baseline');
 const [remaining]=await owner.client<{total:number}[]>`select count(*)::int as total from public.claim_request`;
 expect(remaining.total).toBe(count.total);
 report.writeProbesRolledBack=true;
 save();
},240_000);
