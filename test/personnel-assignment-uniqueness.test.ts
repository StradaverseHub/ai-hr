/** Small native implication/EXPLAIN proof, never a retained-data or release acceptance run. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {personnelListPage} from '../core/read';
import {lockAccessConfigurationReadTx} from '../core/access-configuration-lock';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {personnelNativeAggregatePrototype} from './performance/personnel-native-aggregate-prototype';
import {nativePersonnelPlanDiagnostic} from './performance/personnel-native-plan-diagnostic';
beforeAll(migrateTestDb);afterAll(closeAll);
class WitnessRollback extends Error{}
it('proves current-assignment uniqueness implication before testing join removal',async()=>{
 const report:Record<string,unknown>={kind:'SMALL_NATIVE_ASSIGNMENT_UNIQUENESS_IMPLICATION_AND_PLAN_ONLY',releaseEligible:false,retainedDataAcceptance:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'personnel-assignment-uniqueness.json'),JSON.stringify(report,null,2));};
 const unique='performance_personnel_current_unique',ordering='performance_personnel_unique_name_order';let uniqueCreated=false,orderCreated=false;
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
  const [installed]=await owner.client`select c.contype,c.condeferrable,c.condeferred,c.convalidated,pg_get_constraintdef(c.oid)as definition,pg_get_expr(i.indpred,i.indrelid)as predicate,pg_get_expr(i.indexprs,i.indrelid)as expressions,i.indisexclusion,i.indisvalid,i.indisready,array(select a.attnotnull from pg_attribute a where a.attrelid=c.conrelid and a.attname in('employment_id','valid_from')order by a.attname)as required_not_null,array(select o.oprname::text from unnest(c.conexclop)with ordinality x(oid,n)join pg_operator o on o.oid=x.oid order by n)as operators from pg_constraint c join pg_index i on i.indexrelid=c.conindid where c.conrelid='public.assignment'::regclass and c.conname='assignment_no_overlap'`;
  report.installedConstraint=installed;
  expect(installed.contype).toBe('x');expect(installed.condeferrable).toBe(false);expect(installed.condeferred).toBe(false);expect(installed.convalidated).toBe(true);expect(installed.indisexclusion).toBe(true);expect(installed.indisvalid).toBe(true);expect(installed.indisready).toBe(true);
  expect(installed.predicate).toBe('(superseded_at IS NULL)');expect(installed.expressions).toBe("daterange(valid_from, valid_to, '[)'::text)");expect(installed.required_not_null).toEqual([true,true]);expect(installed.operators).toEqual(['=','&&']);
  // Every current interval has an unbounded upper endpoint and contains the native +infinity
  // date value. Thus any two current intervals overlap, including past/future/infinite lower bounds.
  const bounds=await owner.client`select x::text as lower_bound,isempty(daterange(x,null,'[)'))as empty,daterange(x,null,'[)')@>'infinity'::date as includes_infinity from unnest(array['-infinity'::date,'0001-01-01'::date,current_date,'9999-12-31'::date,'infinity'::date])x`;
  report.rangeWitness=Array.from(bounds);expect(bounds.every(row=>row.empty===false&&row.includes_infinity===true)).toBe(true);
  const proofPerson=randomUUID(),proofEmployment=randomUUID();await owner.db.insert(s.person).values({id:proofPerson,tenantId:b.tenantId,fullName:'Native integrity witness',primaryEmail:proofPerson+'@example.invalid'});
  await owner.db.insert(s.employment).values({id:proofEmployment,tenantId:b.tenantId,personId:proofPerson,companyId:b.companyId,hiredOn:'2000-01-01'});
  type Version={from:string;to?:string|null;superseded?:boolean;tenant?:string;department?:string};
  const states:{name:string;versions:Version[];allowed:boolean;operation?:'close-insert'|'supersede-insert'|'reopen'|'reverse-reopen'}[]=[
   {name:'past-open',versions:[{from:'2020-01-01'}],allowed:true},
   {name:'future-open',versions:[{from:'2099-01-01'}],allowed:true},
   {name:'infinity-open',versions:[{from:'infinity'}],allowed:true},
   {name:'duplicate-open',versions:[{from:'2020-01-01'},{from:'2021-01-01'}],allowed:false},
   {name:'future-and-past-open',versions:[{from:'2099-01-01'},{from:'2000-01-01'}],allowed:false},
   {name:'two-infinity-open',versions:[{from:'infinity'},{from:'infinity'}],allowed:false},
   {name:'negative-infinity-and-future-open',versions:[{from:'-infinity'},{from:'2099-01-01'}],allowed:false},
   {name:'superseded-and-current',versions:[{from:'2020-01-01',superseded:true},{from:'2021-01-01'}],allowed:true},
   {name:'multiple-superseded-open',versions:[{from:'2020-01-01',superseded:true},{from:'2021-01-01',superseded:true}],allowed:true},
   {name:'adjacent-closed-open',versions:[{from:'2020-01-01',to:'2021-01-01'},{from:'2021-01-01'}],allowed:true},
   {name:'empty-closed-with-open',versions:[{from:'2020-01-01',to:'2020-01-01'},{from:'2020-01-01'}],allowed:true},
   {name:'empty-closed-duplicates',versions:[{from:'2020-01-01',to:'2020-01-01'},{from:'2020-01-01',to:'2020-01-01'}],allowed:true},
   {name:'closed-overlap-still-refused',versions:[{from:'2020-01-01',to:'2022-01-01'},{from:'2021-01-01'}],allowed:false},
   {name:'different-tenant-same-employment',versions:[{from:'2020-01-01'},{from:'2021-01-01',tenant:foreign.tenantId,department:foreign.deptA}],allowed:false},
   {name:'close-before-insert-writer',versions:[{from:'2020-01-01'}],operation:'close-insert',allowed:true},
   {name:'supersede-before-insert-writer',versions:[{from:'2020-01-01'}],operation:'supersede-insert',allowed:true},
   {name:'termination-reversal-reopen',versions:[{from:'2020-01-01',to:'2021-01-01'}],operation:'reopen',allowed:true},
   {name:'movement-reversal-reopen',versions:[{from:'2020-01-01',to:'2021-01-01'},{from:'2021-01-01'}],operation:'reverse-reopen',allowed:true},
  ];
  const witness=async()=>{
   const outcomes:unknown[]=[];
   for(const state of states){let outcome:{allowed:boolean;code?:string;constraint?:string}={allowed:true};
    try{await owner.client.begin(async tx=>{
     const inserted:string[]=[];
     for(const v of state.versions){const [row]=await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from,valid_to,superseded_at)values(${v.tenant??b.tenantId}::uuid,${proofEmployment}::uuid,${b.companyId}::uuid,${v.department??b.deptA}::uuid,'full_time',${v.from}::date,${v.to??null}::date,${v.superseded?new Date():null})returning id`;inserted.push(row.id);}
     if(state.operation==='close-insert'||state.operation==='supersede-insert'){
      if(state.operation==='close-insert')await tx`update assignment set valid_to='2021-01-01'where id=${inserted[0]}::uuid`;else await tx`update assignment set superseded_at=now()where id=${inserted[0]}::uuid`;
      await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)values(${b.tenantId}::uuid,${proofEmployment}::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'full_time','2021-01-01')`;
     }
     if(state.operation==='reopen')await tx`update assignment set valid_to=null where id=${inserted[0]}::uuid`;
     if(state.operation==='reverse-reopen'){await tx`update assignment set superseded_at=now()where id=${inserted[1]}::uuid`;await tx`update assignment set valid_to=null where id=${inserted[0]}::uuid`;}
     throw new WitnessRollback();
    });}catch(error){if(!(error instanceof WitnessRollback)){const e=error as{code?:string;constraint_name?:string};outcome={allowed:false,code:e.code,constraint:e.constraint_name};}}
    expect(outcome.allowed,state.name).toBe(state.allowed);outcomes.push({name:state.name,...outcome});
   }return outcomes;
  };
  const originalStates=await witness();report.originalStates=originalStates;save();
  // Install only after the actual native predicate, bounds, nullability, admissible states and
  // writer order implication above passed. No constraint/triggers are weakened or disabled.
  const [absent]=await owner.client`select to_regclass(${'public.'+unique})as relation`;expect(absent.relation).toBeNull();
  await owner.client.unsafe('create unique index '+unique+' on public.assignment(employment_id)where valid_to is null and superseded_at is null');uniqueCreated=true;
  const indexedStates=await witness();report.indexedStates=indexedStates;expect(indexedStates).toEqual(originalStates);
  await owner.client.unsafe('drop index public.'+unique);uniqueCreated=false;
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Native plan company'}).returning();
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Native plan department'}).returning();
  const people=Array.from({length:200},(_,n)=>({id:randomUUID(),employmentId:randomUUID(),name:'Planning Person '+String(n).padStart(4,'0')}));
  await owner.db.insert(s.person).values(people.map(p=>({id:p.id,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.id+'@example.invalid'})));
  await owner.db.insert(s.employment).values(people.map(p=>({id:p.employmentId,tenantId:b.tenantId,personId:p.id,companyId:company.id,hiredOn:'2020-01-01'})));
  await owner.db.insert(s.assignment).values(people.map(p=>({tenantId:b.tenantId,employmentId:p.employmentId,companyId:company.id,departmentId:department.id,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
  for(const table of ['person','employment','assignment','company'])await owner.client.unsafe('analyze '+table);
  const [facts]=await owner.client<{body:string;owner:string;columns:string[]}[]>`select prosrc as body,proowner::regrole::text as owner,proargnames as columns from pg_proc where oid='app.access_workforce_list_facts()'::regprocedure`;
  const plans:{phase:string;mode:string;assignmentNodes:number;totalCost:number;plan:unknown}[]=[];
  const inspect=async(phase:string)=>{
   for(const mode of ['initial','deep','assignment-filter']){
    const filters={companyIds:[company.id],...(mode==='assignment-filter'?{departmentId:department.id}:{})},page={...filters,limit:25,offset:mode==='deep'?175:0};
    const expected=await personnelListPage(ctx,page,filters),native=await personnelNativeAggregatePrototype(page,filters,facts,false);
    const diagnostic=await nativePersonnelPlanDiagnostic(native.query);
    try{const actual=await withTenant(ctx,async tx=>{
     await lockAccessConfigurationReadTx(tx,ctx.tenantId);
     const [row]=await tx.execute<{rows:unknown[];total:number;status_counts:{status:string;count:number}[]}>(native.query);
     const dto={rows:row.rows,total:Number(row.total),headcount:{total:row.status_counts.reduce((n,v)=>n+Number(v.count),0),byStatus:Object.fromEntries(row.status_counts.map(v=>[v.status,Number(v.count)]))}};expect(dto).toEqual(expected);
     const [result]=await tx.execute<{plan:{Plan:Record<string,unknown>}[]}>(diagnostic.query);return result.plan;
    });
     let assignmentNodes=0;const visit=(v:unknown)=>{if(Array.isArray(v))for(const row of v)visit(row);else if(v&&typeof v==='object'){const row=v as Record<string,unknown>;if(row['Relation Name']==='assignment')assignmentNodes++;for(const nested of Object.values(row))visit(nested);}};visit(actual);
     plans.push({phase,mode,assignmentNodes,totalCost:Number(actual[0].Plan['Total Cost']),plan:actual});report.plans=plans;save();
    }finally{await diagnostic.drop();await native.drop();}
   }
  };
  await inspect('original');
  await owner.client.unsafe('create unique index '+unique+' on public.assignment(employment_id)where valid_to is null and superseded_at is null');uniqueCreated=true;await owner.client`analyze assignment`;await inspect('unique-only');
  await owner.client.unsafe('create index '+ordering+' on public.person(tenant_id,full_name,id)');orderCreated=true;await owner.client`analyze person`;await inspect('unique-and-name-order');
  report.proof={rangeImplication:true,all18AdmissibleStateAndWriterOutcomesEqual:true,syntheticFanoutNotARealDataUniquenessProof:true,writerAudit:['core/org.ts:hire,change,terminate,reopen,transfer,location-only','core/hire-correction.ts:supersede-before-replacement','core/information-correction.ts:close-or-supersede-before-replacement','core/movement.ts:supersede-current-before-reopen-previous'],noDirectAssignmentSqlWritersInMigrations:true,drafts:'Employee drafts are a separate table; conversion inserts one live assignment through core/org.ts. The index does not touch drafts.',employmentStates:'The native exclusion/partial predicates do not reference employment tenant/status/void fields; implication applies equally to active, terminated and voided employments. Global employment UUID equality already spans tenant metadata.'};
  save();
  for(const mode of ['initial','deep']){
   const before=plans.find(p=>p.phase==='original'&&p.mode===mode)!,after=plans.find(p=>p.phase==='unique-only'&&p.mode===mode)!;
   expect(before.assignmentNodes).toBeGreaterThan(0);expect(after.assignmentNodes,'Unique current-assignment proof must actually remove the unused LEFT join before any50k spend').toBe(0);expect(after.totalCost).toBeLessThan(before.totalCost);
  }
  expect(plans.find(p=>p.phase==='unique-only'&&p.mode==='assignment-filter')!.assignmentNodes).toBeGreaterThan(0);
 }finally{
  if(orderCreated)await owner.client.unsafe('drop index public.'+ordering);if(uniqueCreated)await owner.client.unsafe('drop index public.'+unique);
  report.prototypeIndexesRemoved=true;save();
 }
},120000);
