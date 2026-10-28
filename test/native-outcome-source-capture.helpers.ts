/** Test-only owner inspection of private source custody. Never a browser/source data reader. */
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {owner} from './harness';
export type ExpectedNativeTarget={kind:'person'|'employment'|'lifecycle_case';id:string};
export async function expectNativeSourceCapture(sourceId:string,eventId:string,targets:readonly ExpectedNativeTarget[]){
 const [capture]=await owner.db.execute<{id:string;event_id:string;target_count:number}>(sql`select id,event_id,target_count from app.native_outcome_source_capture where source_id=${sourceId}::uuid`);
 expect(capture?.event_id).toBe(eventId);
 const rows=await owner.db.execute<{kind:string;target_id:string}>(sql`select kind,target_id from app.native_outcome_source_target where capture_id=${capture.id}::uuid order by kind,target_id`);
 const key=(target:ExpectedNativeTarget)=>target.kind+':'+target.id;
 expect(rows.map(row=>row.kind+':'+row.target_id)).toEqual([...new Set(targets.map(key))].sort());
 expect(capture.target_count).toBe(rows.length);
 return capture;
}
