/** Reuses the exact 500-session bug loop, adding only isolated server-side profiling. */
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner} from '../harness';
import {runClaimsLoad} from '../fixtures/claims-load';
beforeAll(migrateTestDb);afterAll(closeAll);
it('profiles 500-session SQL and enforces the paced speed target',async()=>{
 expect(process.env.AIHR_CI_PG_STATEMENTS).toBe('1');
 await owner.client`create extension if not exists pg_stat_statements`;
 const out=process.env.AIHR_FOCUSED_EVIDENCE_DIR!;expect(out).toBeTruthy();
 await runClaimsLoad('-sql',{
  beforePhase:async()=>{await owner.client`select pg_stat_statements_reset()`;},
  afterPhase:async phase=>{
   const rows=await owner.client`select queryid::text,toplevel,calls,total_exec_time,total_plan_time,mean_exec_time,rows,
    jit_functions,jit_generation_time,jit_inlining_time,jit_optimization_time,jit_emission_time,
    shared_blks_hit,shared_blks_read,temp_blks_written,left(query,8000)as normalized_query
    from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())
    and query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 50`;
   writeFileSync(join(out,'claims-sql-'+phase+'.json'),JSON.stringify(rows,null,2));
  },
 });
 const result=JSON.parse(readFileSync(join(out,'claims-500-sessions-sql.json'),'utf8'));
 expect(result.phases.paced.operations.read.p95Ms,'500-user paced reads must meet 1000ms p95').toBeLessThan(1000);
 for(const operation of ['create','edit','delete'])expect(result.phases.paced.operations[operation].p95Ms,operation+' must meet 500ms p95').toBeLessThan(500);
},240000);
