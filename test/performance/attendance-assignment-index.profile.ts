/** Synthetic access-path scale check; native permission behavior is qualified separately. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner} from '../harness';
import {actorIdentityKeysSql} from './attendance-assignment-sql';
beforeAll(migrateTestDb);afterAll(closeAll);
it('measures indexed frozen-actor lookups over one million synthetic workflow documents',async()=>{
 const tenant=randomUUID(),foreign=randomUUID(),user=randomUUID(),person=randomUUID(),foreignUser=randomUUID(),foreignPerson=randomUUID();
 const phases:Record<string,unknown>={};let scanReferenceMs=0;
 await owner.client.unsafe(actorIdentityKeysSql);
 try{await owner.client.begin(async tx=>{
  await tx.unsafe('CREATE TEMP TABLE perf_possible_history(id bigint,tenant_id uuid,routing_version integer,stages jsonb) ON COMMIT DROP');
  const started=performance.now();
  await tx`insert into perf_possible_history select n,case when n%2=0 then ${tenant}::uuid else ${foreign}::uuid end,4,
   jsonb_build_array(jsonb_build_object('approvers',jsonb_build_array(jsonb_build_object('userId',gen_random_uuid()::text,'personId',gen_random_uuid()::text)))) from generate_series(1,1000000)n`;
  await tx`insert into perf_possible_history values(1000001,${tenant}::uuid,4,${JSON.stringify([{approvers:[{userId:user.toUpperCase().replaceAll('-',''),personId:person.toUpperCase()}]}])}::jsonb)`;
  await tx`insert into perf_possible_history values(1000002,${foreign}::uuid,4,${JSON.stringify([{approvers:[{userId:foreignUser,personId:foreignPerson}]}])}::jsonb)`;
  await tx.unsafe('ANALYZE perf_possible_history');
  const setupMs=performance.now()-started;
  for(const phase of ['scan-before','indexed','scan-restored']){
   let indexBuildMs:number|undefined;
   if(phase==='indexed'){
    await tx.unsafe("SET LOCAL plan_cache_mode='force_generic_plan'");
    const started=performance.now();await tx.unsafe("CREATE INDEX perf_possible_history_gin ON perf_possible_history USING gin (app.perf_actor_identity_keys(stages,'stages')) WHERE routing_version IN(2,3,4)");await tx.unsafe('ANALYZE perf_possible_history');indexBuildMs=performance.now()-started;
   }
   if(phase==='scan-restored'){await tx.unsafe('DROP INDEX perf_possible_history_gin');await tx.unsafe("SET LOCAL plan_cache_mode='auto'");}
   const cases=[];
   for(const match of ['present','absent','foreign-only']){
    const wantedUser=match==='present'?user:match==='foreign-only'?foreignUser:randomUUID();
    const wantedPerson=match==='present'?person:match==='foreign-only'?foreignPerson:randomUUID();
    const times=[];
    for(let i=0;i<(phase==='indexed'?3:1);i++){
     const started=performance.now();
     const rows=await tx`select id from perf_possible_history where tenant_id=${tenant}::uuid and routing_version in(2,3,4)
      and app.perf_actor_identity_keys(stages,'stages') && ARRAY[${wantedUser}::uuid,${wantedPerson}::uuid]limit 1`;
     times.push(performance.now()-started);expect(rows.map(row=>Number(row.id))).toEqual(match==='present'?[1000001]:[]);
    }
    const [explained]=phase==='indexed'?
     await tx`explain(analyze,buffers,format json)select id from perf_possible_history where tenant_id=${tenant}::uuid and routing_version in(2,3,4)
      and app.perf_actor_identity_keys(stages,'stages') && ARRAY[${wantedUser}::uuid,${wantedPerson}::uuid]limit 1`:
     await tx`explain(format json)select id from perf_possible_history where tenant_id=${tenant}::uuid and routing_version in(2,3,4)
      and app.perf_actor_identity_keys(stages,'stages') && ARRAY[${wantedUser}::uuid,${wantedPerson}::uuid]limit 1`;
    const plan=explained['QUERY PLAN'];
    cases.push({match,elapsedMs:times,exactIdAndTenant:true,normalizedStoredIdentityMatched:match==='present',plan});
    phases[phase]={indexBuildAndAnalyzeMs:indexBuildMs,planCacheMode:phase==='indexed'?'force_generic_plan':'auto',cases};
    writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-assignment-index-scale.json'),JSON.stringify({kind:'SYNTHETIC_QUERY_ACCESS_PATH_ONLY',releaseEligible:false,rows:1000002,tenants:2,setupMs,scope:'Synthetic indexed access path; native authority qualified separately. Generic plans are forced only in this disposable benchmark to catch parameter-plan regressions; no runtime setting changes.',phases},null,2));
    if(phase==='indexed'){
     expect(JSON.stringify(plan)).toContain('perf_possible_history_gin');
     expect(times.every(ms=>ms<Math.max(100,scanReferenceMs/10)),'actual generic prepared lookup must avoid the baseline full scan').toBe(true);
    }
   }
   if(phase==='scan-before')scanReferenceMs=Math.min(...cases.flatMap(row=>row.elapsedMs));
   const [size]=await tx`select pg_relation_size('perf_possible_history')::bigint as heap_bytes,case when ${phase}='indexed' then pg_relation_size(to_regclass('perf_possible_history_gin'))::bigint else null end as index_bytes`;
   phases[phase]={indexBuildAndAnalyzeMs:indexBuildMs,planCacheMode:phase==='indexed'?'force_generic_plan':'auto',size,cases};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-assignment-index-scale.json'),JSON.stringify({kind:'SYNTHETIC_QUERY_ACCESS_PATH_ONLY',releaseEligible:false,rows:1000002,tenants:2,setupMs,scope:'Native authorization is tested separately; this measures the same actor-containment expression on a temporary synthetic table, not native request creation or HTTP capacity.',phases},null,2));
  }
 });}finally{await owner.client.unsafe('DROP FUNCTION IF EXISTS app.perf_actor_identity_keys(jsonb,text)');}
},300000);
