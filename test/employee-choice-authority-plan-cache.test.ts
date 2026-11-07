/** Diagnostic only: temporary function-language changes in this job's disposable database.
 * No migration or production source changes. Plans may be reused; authority results must not be. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {employment,reportingLine,roleAssignment} from '../db/schema';
import {readEmployeeChoices} from '../core/employee-choice';
import {closeAll,createAppUser,migrateTestDb,owner} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';

beforeAll(migrateTestDb);afterAll(closeAll);
const signatures=['app.can_see_employment(uuid)','app.can_see_person(uuid)','app.is_admin_for(uuid)'];
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
async function definition(signature:string){
 const [row]=await owner.client`select pg_get_functiondef(p.oid) as definition,p.prosrc as body,l.lanname as language,
  p.proowner::int as owner,p.proacl::text as acl,p.proconfig::text as settings,p.prosecdef as definer,
  p.proisstrict as strict,p.proparallel as parallel,p.provolatile as volatility,p.procost as cost,
  p.proretset as set_returning,p.prorettype::int as return_type,p.proargtypes::text as argument_types
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`;
 if(!row)throw Error('Native diagnostic function missing');
 return row as {definition:string;body:string;language:string;owner:number;acl:string|null;settings:string|null;
  definer:boolean;strict:boolean;parallel:string;volatility:string;cost:number;set_returning:boolean;return_type:number;argument_types:string};
}
function staticStatement(original:Awaited<ReturnType<typeof definition>>){
 expect(original.language).toBe('sql');expect(original.volatility).toBe('s');expect(original.set_returning).toBe(false);
 const marker=/\bAS\s+(\$[A-Za-z_0-9]*\$)[\s\S]*\1\s*$/i.exec(original.definition);
 if(!marker||!/^\s*SELECT\b/i.test(original.body)||original.body.includes('$planning_probe$'))throw Error('Unexpected native function definition');
 const prefix=original.definition.slice(0,marker.index).replace(/\bLANGUAGE\s+sql\b/i,'LANGUAGE plpgsql');
 expect(prefix).not.toBe(original.definition.slice(0,marker.index));
 return prefix+'AS $planning_probe$\nBEGIN\n RETURN ('+original.body.trim().replace(/;\s*$/,'')+');\nEND;\n$planning_probe$;';
}
function authorityMetadata(row:Awaited<ReturnType<typeof definition>>){
 const {definition:_definition,body:_body,language:_language,...metadata}=row;return metadata;
}

it('measures static authority-plan reuse while preserving native grants, visibility and fresh revocation',async()=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 const report:Record<string,unknown>={kind:'DISPOSABLE_NATIVE_AUTHORITY_PLAN_DIAGNOSTIC',releaseEligible:false,employees:50000};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-choice-authority-plan-cache.json'),JSON.stringify(report,null,2));};
 const fixture=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 const originals=await Promise.all(signatures.map(definition));
 report.functions=originals.map((row,index)=>({signature:signatures[index],bodySha256:digest(row.body),language:row.language,...authorityMetadata(row)}));save();
 const single=database.createDb(process.env.TEST_DATABASE_URL!,{max:1});
 const pids=new Set<number>(),timings:Record<string,number[]>={},results:Record<string,unknown>={};
 report.timings=timings;report.results=results;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>
  single.withTenant(ctx,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
   const [identity]=await tx.execute<{role:string;pid:number}>(sql`select current_user as role,pg_backend_pid() as pid`);
   expect(identity.role).toBe('ai_hr_app');pids.add(identity.pid);return read(tx);
  },options));
 let changed=false;
 try{
  const ids=[fixture.expectedFirst[0],fixture.expectedFirst[1],fixture.foreignEmployment];
  const people=await owner.db.select({id:employment.id,personId:employment.personId}).from(employment).where(inArray(employment.id,ids.slice(0,2)));
  const personFor=(id:string)=>people.find(row=>row.id===id)!.personId;
  const employeeUser=await createAppUser(fixture.b.tenantId,personFor(ids[0]),'employee');
  const managerUser=await createAppUser(fixture.b.tenantId,personFor(ids[1]),'manager');
  await owner.db.insert(reportingLine).values({tenantId:fixture.b.tenantId,subordinateEmploymentId:ids[0],managerEmploymentId:ids[1],lineType:'administrative',validFrom:'2020-01-01'});
  const employeeCtx:SessionContext={tenantId:fixture.b.tenantId,userId:employeeUser,personId:personFor(ids[0]),roles:['employee']};
  const managerCtx:SessionContext={tenantId:fixture.b.tenantId,userId:managerUser,personId:personFor(ids[1]),roles:['manager']};
  const visible=(ctx:SessionContext)=>database.withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select e.id from public.employment e
   join public.person p on p.id=e.person_id where e.id=any(${'{'+ids.join(',')+'}'}::uuid[]) order by e.id`),{readOnlySnapshot:true});
  async function verifyVisibility(){
   expect((await visible(employeeCtx)).map(row=>row.id)).toEqual([ids[0]]);
   expect((await visible(managerCtx)).map(row=>row.id)).toEqual(ids.slice(0,2).sort());
   const denied=await readEmployeeChoices(fixture.ctx,{companyIds:[],selectedId:fixture.foreignEmployment,query:'no such fictional employee'});
   expect(denied.selected).toBeNull();expect(denied.total).toBe(0);
  }
  async function measure(mode:string){
   timings[mode]=[];
   for(let repeat=0;repeat<2;repeat++){
    const start=performance.now(),page=await readEmployeeChoices(fixture.ctx,{companyIds:[fixture.b.companyId],selectedId:fixture.expectedLast.at(-1)});
    timings[mode].push(performance.now()-start);
    expect(page.total).toBe(50000);expect(page.rows.map(row=>row.employmentId)).toEqual(fixture.expectedFirst);
    expect(page.rows).toHaveLength(25);expect(page.selected?.employmentId).toBe(fixture.expectedLast.at(-1));
    const projection={rows:page.rows,selected:page.selected,total:page.total,companyOptions:page.companyOptions,
     businessUnitOptions:page.businessUnitOptions,departmentOptions:page.departmentOptions,allDepartmentOptions:page.allDepartmentOptions};
    if(results.baseline)expect(projection).toEqual(results.baseline);else results.baseline=projection;
    save();
   }
  }
  await verifyVisibility();await measure('original_sql');
  await owner.client.begin(async tx=>{for(const original of originals)await tx.unsafe(staticStatement(original));});changed=true;
  for(const [index,signature]of signatures.entries()){
   const actual=await definition(signature);expect(actual.language).toBe('plpgsql');expect(authorityMetadata(actual)).toEqual(authorityMetadata(originals[index]));
  }
  await verifyVisibility();await measure('static_plpgsql');
  await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,managerUser));
  expect((await visible(managerCtx)).map(row=>row.id)).toEqual([]);
  await owner.db.insert(roleAssignment).values({tenantId:fixture.b.tenantId,appUserId:managerUser,role:'manager',companyId:null});
  expect((await visible(managerCtx)).map(row=>row.id)).toEqual(ids.slice(0,2).sort());
  await expect(readEmployeeChoices({...fixture.ctx,personId:randomUUID()},{companyIds:[fixture.b.companyId]})).rejects.toThrow('calling authority');
  expect(pids.size).toBe(1);report.sameBackendAcrossAuthorityChanges=true;report.permissionResultsCached=false;report.phase='completed';save();
 }finally{
  spy.mockRestore();
  if(changed){
   await owner.client.begin(async tx=>{for(const original of originals)await tx.unsafe(original.definition);});
   for(const [index,signature]of signatures.entries())expect(await definition(signature)).toEqual(originals[index]);
   report.originalDefinitionsRestored=true;
  }
  await single.client.end();save();
 }
},300000);
