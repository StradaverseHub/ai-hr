import {redirect} from 'next/navigation';
import {sql, type SQL} from 'drizzle-orm';
import {getSession} from './session';
import {getScopeIds} from './scope';
import {personnelPageAccessFrom, personnelPageAccessSql, workforceViewScope} from '../core/workforce-access';
import {withPersonnelOverviewRead, type PersonnelOverviewSnapshot} from '../core/personnel-read-bounds';
import type {SessionContext, Tx} from '../db/client';

/** What a gated page read receives: the same scope the plain gate returns, inside its own snapshot. */
export type WorkforcePageRead = {
 s: SessionContext; scopeIds: string[]; allowedCount: number; companyIds: string[]; maintainIds: string[];
 tx: Tx; snapshot: PersonnelOverviewSnapshot; extra: unknown;
};

/** Purpose-bound page scope. A role name or the ordinary directory scope cannot mint this grant.
 * With `read`, the gate and the page's reads share one read-only snapshot: the Workforce scope (the
 * same predicate as workforceViewScope) is answered in the snapshot's bounds statement, before `read`
 * runs, and a reader who may not open the surface is redirected exactly as before. */
export async function requireWorkforceAccess(options?: { personnelList: true }): Promise<{s: SessionContext; scopeIds: string[]; allowedCount: number; companyIds: string[]}>;
export async function requireWorkforceAccess<T>(options: { personnelList: true; extra?: (s: SessionContext) => SQL; read: (access: WorkforcePageRead) => Promise<T> }): Promise<T>;
export async function requireWorkforceAccess<T>(options?: { personnelList: true; extra?: (s: SessionContext) => SQL; read?: (access: WorkforcePageRead) => Promise<T> }) {
 const s=await getSession();
 const read=options?.read;
 if(!read){
  const allowed=await workforceViewScope(s, options);
  if(!allowed.canOpen)redirect('/');
  return {s,scopeIds:await getScopeIds(allowed.companyIds),allowedCount:allowed.companyIds.length,companyIds:allowed.companyIds};
 }
 const extra=sql`jsonb_build_object('access', ${personnelPageAccessSql}, 'extra', ${options.extra?.(s) ?? sql`null::jsonb`})`;
 const outcome=await withPersonnelOverviewRead(s, async (tx, snapshot) => {
  const value=snapshot.extra as {access: unknown; extra: unknown};
  const allowed=personnelPageAccessFrom(value.access);
  if(!allowed.canOpen)return {open:false as const};
  const scopeIds=await getScopeIds(allowed.companyIds);
  return {open:true as const,value:await read({s,scopeIds,allowedCount:allowed.companyIds.length,companyIds:allowed.companyIds,
   maintainIds:allowed.maintainIds,tx,snapshot,extra:value.extra})};
 }, {extra});
 if(!outcome.open)redirect('/');
 return outcome.value;
}
