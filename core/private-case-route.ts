/** AI v2 Phase 1 W11 — whether the "Start a private case with HR" route is offered to this person for this company
 * (ADR-0173). The protected case route is configured for a company once it has an eligible handler (a current grant held
 * by a current login, neither archived nor blocked: app.private_case_route_configured); the person must hold
 * a current employment there. Imported by core/teras-wiring/turn.ts, so it stays tiny: one existence check, no case
 * read, no text, nothing from core/private-cases.ts. A failure answers false (the reply keeps the HR contact alone). */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';

/** The intake form. The AI never opens it, prefills it or reads what is written there. */
export const PRIVATE_CASE_START_PATH='/me/cases/new';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export async function privateCaseRouteAvailable(ctx:SessionContext,companyId:unknown):Promise<boolean>{
 if(!ctx.userId||ctx.agent||!uuid(companyId))return false;
 try{
  return await withTenant(ctx,async tx=>{
   const [row]=await tx.execute<{ok:boolean}>(sql`select (app.private_case_route_configured(${ctx.tenantId}::uuid,${companyId}::uuid) is true
    and app.private_case_author_company(${companyId}::uuid)) as ok`);
   return row?.ok===true;
  });
 }catch{return false;}
}
