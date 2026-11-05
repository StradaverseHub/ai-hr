/** Disposable native experiment. The existing record, editor, and protected review owners stay installed and unchanged. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {withTenant,type SessionContext} from '../../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';

const file='test/performance/personnel-bounded-profile.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('matches finite Workforce record/editor bytes and avoids the whole Workforce JSON projection',async()=>{
 const report:Record<string,unknown>={kind:'NATIVE_SMALL_WORKFORCE_PROFILE_POINT_READ_ONLY',releaseEligible:false,retainedEmployees:2000};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-bounded-profile.json'),JSON.stringify(report,null,2));
 const oldRecord='app.access_workforce_record',oldEditor='app.access_workforce_editor';
 const nextRecord='app.performance_workforce_record_one',nextEditor='app.performance_workforce_editor_one';
 const explainRecord='app.performance_workforce_record_old_plan',explainNext='app.performance_workforce_record_new_plan';
 type Native={identity:string;owner:string;body:string;definition:string;acl:string;config:string[]};
 const native=()=>owner.client<Native[]>`select oid::regprocedure::text as identity,proowner::regrole::text as owner,
  prosrc as body,pg_get_functiondef(oid) as definition,proacl::text as acl,proconfig as config
  from pg_proc where oid=any(array['app.access_workforce_record(uuid)'::regprocedure,'app.access_workforce_editor(uuid)'::regprocedure,
   'app.access_workforce_list_rows()'::regprocedure,'app.access_workforce_list_rows_for_ids(uuid[])'::regprocedure])order by oid`;
 let before:Native[]|undefined,installed=false;
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),actor=adminCtx(b);
  before=Array.from(await native());
  const record=before.find(r=>r.identity===oldRecord+'(uuid)')!,editor=before.find(r=>r.identity===oldEditor+'(uuid)')!;
  expect(record).toBeTruthy();expect(editor).toBeTruthy();
  const source='app.access_workforce_list_rows() AS listing(value)';
  expect(record.body.split(source)).toHaveLength(2);
  expect(editor.body.split(oldRecord+'(selected.id)')).toHaveLength(2);
  const body=record.body.replace(source,'app.access_workforce_list_rows_for_ids(array[p_employment]) AS listing(value)');
  const p=randomUUID().slice(0,24),e=randomUUID().slice(0,24),subject=e+'000000002000';
  const [other]=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name)
   values(${b.tenantId}::uuid,'Fictional second bounded record company') returning id`;
  await owner.client`insert into person(id,tenant_id,full_name,primary_email,preferred_name)
   select (${p}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
    'Fictional point profile '||lpad(n::text,6,'0'),${p}||n::text||'@example.invalid','Point '||n::text
    from generate_series(1,2000)n`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
   select (${e}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${p}||lpad(n::text,12,'0'))::uuid,
    case when n=1 then ${other.id}::uuid else ${b.companyId}::uuid end,'POINT'||n::text,date '2020-01-01'
    from generate_series(1,2000)n`;
  await owner.client`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   values(${b.tenantId}::uuid,${subject}::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'full_time',date '2020-01-01')`;
  const fp=randomUUID(),fe=randomUUID();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email) values(${fp}::uuid,${foreign.tenantId}::uuid,'Foreign fictional profile',${fp+'@example.invalid'})`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${fe}::uuid,${foreign.tenantId}::uuid,${fp}::uuid,${foreign.companyId}::uuid,date '2020-01-01')`;
  for(const table of ['person','employment','assignment','company'])await owner.client.unsafe('analyze '+table);
  const diagnostic=(name:string,query:string)=>'create function '+name+'(p_employment uuid) returns json language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $diag$declare result json;begin execute $query$explain(analyze,buffers,format json) '+query+'$query$ into result using p_employment;return result;end$diag$';
  const names=[nextRecord,nextEditor,explainRecord,explainNext];
  await owner.client.begin(async tx=>{
   await tx.unsafe(record.definition.replace(oldRecord+'(',nextRecord+'(').replace(record.body,body));
   await tx.unsafe(editor.definition.replace(oldEditor+'(',nextEditor+'(').replace(oldRecord+'(selected.id)',nextRecord+'(selected.id)'));
   await tx.unsafe(diagnostic(explainRecord,record.body.replaceAll('p_employment','$1').trim().replace(/;$/,'')));
   await tx.unsafe(diagnostic(explainNext,body.replaceAll('p_employment','$1').trim().replace(/;$/,'')));
   for(const name of names)await tx.unsafe('revoke all on function '+name+'(uuid) from public;grant execute on function '+name+'(uuid) to ai_hr_app');
   const properties=await tx<{owner:string;definer:boolean;app:boolean;public_execute:boolean}[]>`select proowner::regrole::text as owner,prosecdef as definer,has_function_privilege('ai_hr_app',oid,'EXECUTE')as app,exists(select 1 from aclexplode(proacl)where grantee=0 and privilege_type='EXECUTE')as public_execute from pg_proc where oid=any(array[${nextRecord+'(uuid)'}::regprocedure,${nextEditor+'(uuid)'}::regprocedure,${explainRecord+'(uuid)'}::regprocedure,${explainNext+'(uuid)'}::regprocedure])`;
   expect(properties).toHaveLength(4);
   expect(record.owner).toBe(editor.owner);
   for(const row of properties)expect(row).toEqual({owner:record.owner,definer:true,app:true,public_execute:false});
  });installed=true;
  const metadata=await owner.client`select to_regprocedure('app.performance_workforce_record_one(uuid)')::text as record`;
  expect(metadata[0].record).toBeTruthy();
  const query=(ctx:SessionContext,recordName:string,editorName:string,id:string|null)=>withTenant(ctx,async tx=>{
   await lockAccessConfigurationReadTx(tx,ctx.tenantId);
   const [row]=await tx.execute<{record:unknown;editor:unknown;role:string}>(sql`select ${sql.raw(recordName)}(${id}::uuid) as record,
    ${sql.raw(editorName)}(${id}::uuid) as editor,current_user as role`);
   expect(row.role).toBe('ai_hr_app');return row;
  });
  const assertEqual=async(ctx:SessionContext,id:string|null,visible:boolean)=>{
   const baseline=await query(ctx,oldRecord,oldEditor,id),candidate=await query(ctx,nextRecord,nextEditor,id);
   expect(candidate).toEqual(baseline);
   if(visible)expect(candidate.record).toMatchObject({employment:{employmentId:id}});
   else expect(candidate.record).toBeNull();
   return candidate;
  };
  const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');
  await owner.client`update role_assignment set company_id=${b.companyId}::uuid where app_user_id=${scopedUser}::uuid`;
  const scoped={...actor,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const employeeUser=await createAppUser(b.tenantId,null,'employee');
  const employee={...actor,userId:employeeUser,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const allowed=await assertEqual(actor,subject,true);
  expect(allowed.editor).toMatchObject({profile:{preferredName:'Point 2000'}});
  for(const [ctx,id,visible] of [[actor,e+'000000000001',true],[actor,fe,false],[actor,null,false],[actor,randomUUID(),false],
   [scoped,subject,true],[scoped,e+'000000000001',false],[employee,subject,false],[{...actor,userId:randomUUID()},subject,false],
   [adminCtx(foreign),subject,false]] as const)await assertEqual(ctx,id,visible);
  await owner.client`update app_user set archived_at=now() where id=${scopedUser}::uuid`;
  try{await assertEqual(scoped,subject,false);}finally{await owner.client`update app_user set archived_at=null where id=${scopedUser}::uuid`;}
  await owner.client`update role_assignment set company_id=${other.id}::uuid where app_user_id=${scopedUser}::uuid`;
  try{await assertEqual(scoped,subject,false);}finally{await owner.client`update role_assignment set company_id=${b.companyId}::uuid where app_user_id=${scopedUser}::uuid`;}
  report.exactCases=12;save();
  const measurements=[];
  for(const [stage,r,ed] of [['original',oldRecord,oldEditor],['candidate',nextRecord,nextEditor],
   ['candidate-warm',nextRecord,nextEditor],['restored',oldRecord,oldEditor]] as const){
   const start=performance.now();
   for(let i=0;i<3;i++)expect(await query(actor,r,ed,subject)).toEqual(allowed);
   measurements.push({stage,threeProfileAndEditorPairsMs:performance.now()-start});
  }
  const plans=await withTenant(actor,async tx=>{
   await lockAccessConfigurationReadTx(tx,b.tenantId);
   const [row]=await tx.execute<{baseline:unknown;candidate:unknown}>(sql`select ${sql.raw(explainRecord)}(${subject}::uuid) as baseline,${sql.raw(explainNext)}(${subject}::uuid) as candidate`);
   return row;
  });
  const nodes=(v:unknown):Record<string,unknown>[]=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?
   [...('Node Type' in v?[v as Record<string,unknown>]:[]),...Object.values(v).flatMap(nodes)]:[];
  const baseline=nodes(plans.baseline).find(node=>node['Function Name']==='access_workforce_list_rows');
  const candidate=nodes(plans.candidate).find(node=>node['Function Name']==='access_workforce_list_rows_for_ids');
  report.measurements=measurements;report.plans=plans;report.originalJsonNode=baseline;report.candidateJsonNode=candidate;save();
  expect(baseline).toBeTruthy();expect(candidate).toBeTruthy();
  expect(Number(baseline?.['Rows Removed by Filter']??0)+Number(baseline?.['Actual Rows']??0)).toBeGreaterThan(1000);
  expect(Number(candidate?.['Rows Removed by Filter']??0)+Number(candidate?.['Actual Rows']??0)).toBe(1);
  expect(Math.max(measurements[1].threeProfileAndEditorPairsMs,measurements[2].threeProfileAndEditorPairsMs)).toBeLessThan(.8*Math.min(measurements[0].threeProfileAndEditorPairsMs,measurements[3].threeProfileAndEditorPairsMs));
 }finally{
  if(installed)for(const name of [explainRecord,explainNext,nextEditor,nextRecord])await owner.client.unsafe('drop function '+name+'(uuid)');
  if(before)expect(Array.from(await native())).toEqual(before);
  report.nativeOwnersUnchanged=!!before;report.prototypeObjectsRemoved=true;save();
 }
},120000);
