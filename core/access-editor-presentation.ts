/** Proposed adapter only. No application import or route is changed by this prototype. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {pgSqlState} from '../../lib/db-error';
import {AccessPermissionError} from '../../lib/access-permission-model';
import {parseAccessOwnerState} from '../../lib/access-owner-state';
import {parseAccessEditorMetadata} from '../../lib/access-editor-data';
type NativeStatus={read_status:'initialized'|'uninitialized';state:unknown;metadata:unknown};
const capture=(supplied:SessionContext):SessionContext=>({...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))});
export async function readAccessEditorPrototypeStatus(supplied:SessionContext){
 const ctx=capture(supplied);
 try{return await withTenant(ctx,async tx=>{
  const rows=await tx.execute<NativeStatus>(sql`select * from app.access_editor_presentation_v1()`);
  const row=rows[0];
  if(rows.length!==1||!row||Object.keys(row).sort().join(',')!=='metadata,read_status,state')throw new AccessPermissionError('invalid');
  if(row.read_status==='uninitialized'){
   if(row.state!==null||row.metadata!==null)throw new AccessPermissionError('invalid');
   return {status:'uninitialized'}as const;
  }
  if(row.read_status!=='initialized')throw new AccessPermissionError('invalid');
  const current=parseAccessOwnerState(row.state,ctx.tenantId),metadata=parseAccessEditorMetadata(row.metadata,current.snapshot,current.evidence.knownCompanyIds);
  return {status:'initialized',data:{snapshot:current.snapshot,scopeFingerprint:current.scopeFingerprint,
   capabilities:current.catalog.map(({id,scope,supported})=>({id,scope,supported})),...metadata}}as const;
 },{readOnlySnapshot:true});}
 catch(error){if(pgSqlState(error)==='42501')throw new AccessPermissionError('ceiling');throw error;}
}
export async function readAccessEditorPrototype(supplied:SessionContext){
 const ctx=capture(supplied),first=await readAccessEditorPrototypeStatus(ctx);
 if(first.status==='initialized')return first.data;
 // Only an authenticated native uninitialized discriminant enters the unchanged command.
 // Exceptions, missing rows and malformed projections never select this branch.
 await withTenant(ctx,tx=>tx.execute(sql`select app.access_configuration_initialize()`));
 const fresh=await readAccessEditorPrototypeStatus(ctx);
 if(fresh.status!=='initialized')throw new AccessPermissionError('invalid');
 return fresh.data;
}
