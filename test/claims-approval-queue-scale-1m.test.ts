/** Same-run Claims queue SQL comparison on the million-claim fixture.
 * Keep the exact reader and its tenant bindings. Compare only PostgreSQL CTE planning choices. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {seedClaimQueueScaleFixture} from './performance/claims-approval-queue-scale-fixture';
import {closeAll,migrateTestDb} from './harness';
import {client} from '../db/client';
import {listPendingClaimsPage} from '../packs/claims/service';
import {isIdentityStatement,observeStatements,type Captured} from './helpers/statement-observer';

beforeAll(migrateTestDb);afterAll(closeAll);

it('compares equivalent SQL queue shapes for group HR and a manager',async()=>{
 const report:Record<string,unknown>={kind:'CLAIMS_QUEUE_MATERIALIZATION_A_B_V1',employees:100000,claimsPerEmployee:10,managerReports:1000,complete:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'claims-queue-materialization-comparison.json'),JSON.stringify(report,null,2));};
 const fixture=await seedClaimQueueScaleFixture({employees:100000,claimsPerEmployee:10,managerReports:1000},report,save);
 expect(fixture.counts).toEqual({claims:1000010,managerClaims:10010});
 const results:Record<string,unknown>={};
 report.results=results;
 const sqlShapes=[
  {name:'current',rewrite:(text:string)=>text},
  {name:'inline-pending-requests',rewrite:(text:string)=>text.replace('queue_request as materialized','queue_request as not materialized')},
  {name:'inline-employment-counts',rewrite:(text:string)=>text.replace('queue_employment as materialized','queue_employment as not materialized')},
 ] as const;
 for(const [label,context,total] of [
  ['groupHr',fixture.groupHr,1000010],
  ['manager',fixture.lineManager,10010],
 ] as const){
  const captured=await observeStatements(()=>listPendingClaimsPage(context));
  expect(captured.result.page.total).toBe(total);
  const identity=captured.statements.filter(row=>isIdentityStatement(row.sql));
  const queue=captured.statements.filter(row=>row.sql.includes('queue_request as materialized')&&row.sql.includes('queue_employment as materialized'));
  expect(identity).toHaveLength(1);
  expect(queue).toHaveLength(1);
  const statement=queue[0];
  const shapes=sqlShapes.map(({name,rewrite})=>({name,text:rewrite(statement.sql)}));
  expect(new Set(shapes.map(({text})=>text)).size).toBe(shapes.length);
  const timings:Record<string,number[]>={};
  let expected:unknown;
  const replay=(row:Captured,text=row.sql)=>client.begin(async tx=>{
   await tx.unsafe('set transaction isolation level repeatable read read only');
   await tx.unsafe(identity[0].sql,identity[0].params as never[]);
   const started=performance.now();
   const [reply]=await tx.unsafe(text,row.params as never[]);
   return {result:reply?.result,elapsedMs:Math.round(performance.now()-started)};
  });
  const rounds=[shapes,[...shapes.slice(1),shapes[0]],[shapes[2],...shapes.slice(0,2)]];
  for(const round of rounds){
   for(const {name,text} of round){
    const {result,elapsedMs}=await replay(statement,text);
    if(expected===undefined){
     expect(result).toMatchObject({total});
     expected=result;
    }
    expect(result).toEqual(expected);
    (timings[name]??=[]).push(elapsedMs);
   }
  }
  results[label]={total,timings};
  save();
 }
 report.complete=true;report.phase='complete';save();
},900000);
