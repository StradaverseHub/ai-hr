/** AI Centre restructure (owner decision 29, 4 November 2026) — what the missing-employee-data loop has asked, for
 * Operations › Record readiness, the one list of record gaps.
 *
 * For the employments a readiness screen lists, the loop's current case per employment: `open` (the loop prepared the
 * employee's self-service request card and it waits on them) or `waiting` (the employee sent their request and it waits
 * for HR's approval), with the gaps it names and when it was opened. A closed case is not returned: nothing is being
 * asked any more.
 *
 * Read only, as the viewer: HR or group administrators only (the page's requireAdmin, and checked again here), under the
 * viewer's row-level security on teras_loop_case (migration 0960), so an HR administrator of one company sees that
 * company's cases only. No figure is computed and nothing is written. */
import {and,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasLoopCase} from '../../db/teras-schema';
import {isAdmin} from '../../lib/authz-model';
import {LoopViewRefused} from './views';

export const READINESS_LOOP='loop_missing_employee_data' as const;
export type ReadinessAsk=Readonly<{state:'open'|'waiting';openedAt:Date;gaps:readonly string[]}>;

/** At most this many employments per read (a readiness screen lists at most 25 people per gap). */
const BATCH=500;

export async function readinessLoopAsks(ctx:SessionContext,employmentIds:readonly string[]):Promise<ReadonlyMap<string,ReadinessAsk>>{
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LoopViewRefused('not_administrator');
 const ids=[...new Set(employmentIds.filter(id=>/^[0-9a-f-]{36}$/i.test(id)))];
 if(!ids.length)return new Map();
 return withTenant(ctx,async tx=>{
  const out=new Map<string,ReadinessAsk>();
  for(let offset=0;offset<ids.length;offset+=BATCH){
   const rows=await tx.select({employmentId:terasLoopCase.employmentId,state:terasLoopCase.state,openedAt:terasLoopCase.openedAt,facts:terasLoopCase.facts})
    .from(terasLoopCase)
    .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,READINESS_LOOP),inArray(terasLoopCase.state,['open','waiting']),
     inArray(terasLoopCase.employmentId,ids.slice(offset,offset+BATCH))));
   for(const row of rows){
    if(!row.employmentId||(row.state!=='open'&&row.state!=='waiting'))continue;
    const gaps=Array.isArray((row.facts as {gaps?:unknown}|null)?.gaps)?((row.facts as {gaps:unknown[]}).gaps.filter((gap):gap is string=>typeof gap==='string')):[];
    out.set(row.employmentId,Object.freeze({state:row.state,openedAt:row.openedAt,gaps:Object.freeze(gaps)}));
   }
  }
  return out;
 },{readOnlySnapshot:true});
}
