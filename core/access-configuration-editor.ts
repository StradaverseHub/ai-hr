/** One locked fresh read for the page; only the minimized result is eligible for client props. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {accessConfigurationStore} from './access-configuration-store';
import {parseAccessEditorMetadata} from '../lib/access-editor-data';
/** Navigation hint only; page, preview and commit independently repeat their current SQL checks. */
export function canConfigureAccess(ctx:SessionContext){
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_capability_allowed('access.configure',NULL) as allowed`);
  return row?.allowed===true;
 });
}
export function readAccessConfigurationEditor(ctx:SessionContext){
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  const current=await accessConfigurationStore.loadCurrent(tx,ctx);
  const [row]=await tx.execute<{metadata:unknown}>(sql`select app.access_configuration_editor_metadata() as metadata`);
  const metadata=parseAccessEditorMetadata(row?.metadata,current.snapshot,current.evidence.knownCompanyIds);
  // No owner/evidence functions, lifecycle eligibility, binding paths or session grants are props.
  return {snapshot:current.snapshot,scopeFingerprint:current.scopeFingerprint,
   capabilities:current.catalog.map(({id,scope,supported})=>({id,scope,supported})),...metadata};
 });
}
