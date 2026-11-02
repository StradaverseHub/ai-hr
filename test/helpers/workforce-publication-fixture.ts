/** Publish only the implemented Workforce package, using its real restricted installer.
 * A fixture that needs an administrative Data Profile must exercise the same grant ceiling as
 * a published installation. This leaves the unfinished function catalogue unpublished and uses the real legacy parity copy. */
import {accessConfigurationStore} from '../../core/access-configuration-store';
import {withTenant,type SessionContext} from '../../db/client';
import {publishWorkforceActionPackage,WORKFORCE_CAPABILITY_BINDINGS_V2} from '../../deploy/access/publish-workforce-capabilities';
import {owner} from '../harness';

export async function publishWorkforceForDataFixture(ctx:SessionContext,cleanups:(()=>Promise<void>)[]){
 const ids=WORKFORCE_CAPABILITY_BINDINGS_V2.map(row=>row.id);
 const previous=await owner.client<{id:string;supported:boolean;bindings:unknown}[]> `
  select id,supported,bindings from public.access_capability where id=any(${ids}::text[])`;
 cleanups.push(async()=>{for(const row of previous){
  await owner.client`update public.access_capability set supported=${row.supported},bindings=${JSON.stringify(row.bindings)}::text::jsonb where id=${row.id}`;
 }});
 await withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx));
 await publishWorkforceActionPackage(owner.client);
}
