import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,owner} from './harness';
import {pendingSigningSteps,type SigningDocument} from '../lib/document-signing-model';
beforeAll(async()=>{await migrateTestDb();});
afterAll(closeAll);

it('keeps SQL routing and optional-stage authority identical to the signing model',async()=>{
 const definition=[{id:'review',order:1,action:'review',owner:true,required:false,who:{kind:'employee'}},{id:'ack',order:2,action:'acknowledge',owner:false,required:true,who:{kind:'employee'}}];
 const [valid]=await owner.db.execute<{ok:boolean}>(sql`select app.probation_letter_routing_valid(${JSON.stringify(definition)}::jsonb) as ok`);
 expect(valid.ok).toBe(true);
 const [invalid]=await owner.db.execute<{ok:boolean}>(sql`select app.probation_letter_routing_valid(${JSON.stringify(definition.map(step=>({...step,required:false})))}::jsonb) as ok`);
 expect(invalid.ok).toBe(false);
 const [blocks]=await owner.db.execute<{ok:boolean}>(sql`select app.probation_letter_routing_signatures_ok(${JSON.stringify({routing:definition,blocks:[{id:'signature',type:'signature',role:'step:ack'}]})}::jsonb) as ok`);
 expect(blocks.ok).toBe(true);
 const data:SigningDocument={tenantId:'t',companyId:'c',subjectId:'s',subjectType:'probation',contentRevision:1,contentHash:'a'.repeat(64),route:{version:1,steps:[{id:'review',role:'reviewer',kind:'review',stage:1,holderId:'reviewer',required:false},{id:'ack',role:'employee',kind:'acknowledge',stage:2,holderId:'employee',required:true}]},actions:[],routing:{templateId:'t',templateVersion:1,caseOwnerId:'hr'}};
 for(const routed of [true,false]){
  const document={...data,...(!routed?{routing:undefined}:{})};
  const rows=await owner.db.execute<{id:string}>(sql`select step->>'id' as id from app.document_signing_pending_steps(${JSON.stringify(JSON.parse(JSON.stringify(document)))}::jsonb) step`);
  expect(rows.map(row=>row.id)).toEqual(pendingSigningSteps(document).map(step=>step.id));
 }
});
