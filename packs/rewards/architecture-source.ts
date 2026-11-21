import 'server-only';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx} from '../../db/client';
import type {RewardArchitectureSource} from './model';
const source=z.object({positionId:z.uuid(),mappingRevision:z.number().int().positive(),catalogueRevision:z.number().int().positive(),jobUnitId:z.uuid(),jobUnitTitle:z.string().max(160),classification:z.array(z.string().max(160)).max(4),gradeId:z.uuid(),gradeCode:z.string().max(16)}).strict();
/** Bounded SQL owner rechecks the unit, employment, assignment date and approved revisions. */
export async function rewardArchitectureForSourceTx(tx:Tx,unitId:string,employmentId:string,positionId:string|null,asOf:string):Promise<RewardArchitectureSource|null>{
 if(!positionId)return null;
 const [r]=await tx.execute<{value:unknown}>(sql`select app.reward_architecture_for_source(${z.uuid().parse(unitId)}::uuid,${z.uuid().parse(employmentId)}::uuid,${z.uuid().parse(positionId)}::uuid,${z.iso.date().parse(asOf)}::date) as value`);
 return r?.value===null?null:source.parse(r?.value);
}
/** rewardArchitectureForSourceTx for every listed entry of one review in one statement, with the same validation, the
 * same SQL owner per entry and the same parse; an entry without a position has no architecture and no SQL call. */
export async function rewardArchitectureForSourcesTx(tx:Tx,unitId:string,entries:readonly {employmentId:string;positionId:string|null}[],asOf:string):Promise<Map<string,RewardArchitectureSource|null>>{
 const unit=z.uuid().parse(unitId),date=z.iso.date().parse(asOf),out=new Map<string,RewardArchitectureSource|null>();
 const positioned=entries.filter(entry=>entry.positionId).map(entry=>({employment_id:z.uuid().parse(entry.employmentId),position_id:z.uuid().parse(entry.positionId)}));
 for(const entry of entries)if(!entry.positionId)out.set(entry.employmentId,null);
 if(!positioned.length)return out;
 const rows=await tx.execute<{employment_id:string;value:unknown}>(sql`select x.employment_id::text as employment_id,
  app.reward_architecture_for_source(${unit}::uuid,x.employment_id,x.position_id,${date}::date) as value
  from jsonb_to_recordset(${JSON.stringify(positioned)}::text::jsonb) as x(employment_id uuid,position_id uuid)`);
 const values=new Map(rows.map(row=>[row.employment_id,row.value]));
 for(const entry of positioned){const value=values.get(entry.employment_id);out.set(entry.employment_id,value===null?null:source.parse(value));}
 return out;
}
