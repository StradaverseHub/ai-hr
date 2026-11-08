import {assertAiCentreRunningTx} from '../ai-centre-control';
/** AI v2 Phase 2 hardening (4 November 2026) — whether a loop may still act for a company, re-checked INSIDE the
 * transaction that applies an automatic action (core/loops/act-clock-outs.ts applyClockOut, act-requests.ts
 * applyRequest), at its start and again just before it commits.
 *
 * The attempt is recorded as the agent principal under the company's lock, against the level then (core/loops/act.ts),
 * and applied afterwards under the sponsor's authority. Between the two a group administrator may switch the loop off,
 * stop the tenant, pause the company or move the loop below Level 2 (and the automatic demotion may do the last). The
 * apply transaction reads all four as they are committed now (each table is readable in the tenant): if any no longer
 * allows acting, the owner's change is not made, or is rolled back, and the action is recorded as not applied with the
 * reason `loop_stopped`. Nothing is written here. No model. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../../db/client';
import {LoopActRefused} from './act-clock-outs';

export async function loopMayStillActTx(tx:Tx,p:Readonly<{tenantId:string;workerId:string;companyId:string}>):Promise<boolean>{
 await assertAiCentreRunningTx(tx,{tenantId:p.tenantId});
 const [row]=await tx.execute(sql`select exists(select 1 from public.teras_worker_control w where w.tenant_id=${p.tenantId}::uuid and w.worker_id=${p.workerId} and w.enabled)
  and not exists(select 1 from public.teras_mandate_control c where c.tenant_id=${p.tenantId}::uuid and c.stopped)
  and not exists(select 1 from public.teras_loop_pause s where s.tenant_id=${p.tenantId}::uuid and s.worker_id=${p.workerId} and s.company_id=${p.companyId}::uuid and s.paused)
  and app.teras_loop_level_of(${p.workerId},${p.companyId}::uuid)>=2 as ok`) as unknown as {ok:boolean|null}[];
 return row?.ok===true;
}

/** Throws `loop_stopped` when the loop may no longer act for the company. */
export async function requireLoopMayStillActTx(tx:Tx,p:Readonly<{tenantId:string;workerId:string;companyId:string}>):Promise<void>{
 if(!await loopMayStillActTx(tx,p))throw new LoopActRefused('loop_stopped');
}
