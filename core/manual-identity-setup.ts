/** Board 0735d1b7 — which people have a manual account setup (Set Username and Password) in progress, for the batch
 * invitation's eligibility. The enrollment store is owner-only; the existing app.manual_identity_list definer is its
 * only read, and it answers only for a group administrator who signs in through the same embedded or Keycloak issuer
 * (app.manual_identity_authorized). Without that issuer nothing can be listed, and nothing is (an empty list): the
 * single-person screens have the same limit. Separate from core/manual-identity.ts so core/auth.ts can use it without
 * an import cycle. Two statements (the proof, then the list) inside the caller's transaction. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {internalSelected,internalIssuer} from '../lib/internal-auth/config';
import {keycloakConfig,keycloakSelected} from '../lib/identity/config';

export async function manualSetupPersonIdsTx(tx:Tx,ctx:SessionContext):Promise<string[]>{
 if(!internalSelected()&&!keycloakSelected())return [];
 const issuer=internalSelected()?internalIssuer(ctx.tenantId):keycloakConfig().issuer;
 const [proof]=await tx.execute<{allowed:boolean}>(sql`select app.manual_identity_authorized(${issuer}) as allowed`);
 if(!proof?.allowed)return [];
 const rows=await tx.execute<{person_id:string}>(sql`select l.person_id from app.manual_identity_list(${issuer}) l where l.status in ('reserved','prepared')`);
 return [...rows].map(row=>row.person_id);
}
