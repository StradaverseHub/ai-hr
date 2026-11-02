import { withTenant } from '../db/client';
import { provisionInternalOrganization } from '../lib/internal-auth/provision-organization';
import { adminCtx,type Base } from './harness';
/** Exercise the same immutable organization registration used by installation provisioning. */
export function provisionEntraTestOrganization(base:Base,code:string){
  return withTenant(adminCtx(base),tx=>provisionInternalOrganization(tx,{tenantId:base.tenantId,code,name:'Entra test organization'}));
}
