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
