/** One explicit native RR/RO projection; only the minimized result becomes client props. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {readAccessEditorPresentation} from './access-editor-presentation';
export const accessConfigurationNavigationAllowedSql=sql`app.access_capability_allowed('access.configure',NULL)`;

/** Navigation hint only; page, preview and commit independently repeat their current SQL checks. */
export function canConfigureAccess(ctx:SessionContext){
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{allowed:boolean}>(sql`select ${accessConfigurationNavigationAllowedSql} as allowed`);
  return row?.allowed===true;
 });
}
export function readAccessConfigurationEditor(ctx:SessionContext){
 return readAccessEditorPresentation(ctx);
}
