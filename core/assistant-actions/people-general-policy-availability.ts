/** Current authorized form defaults only; private revisions/authority never reach the browser. */
import {withTenant,type SessionContext} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {lockPeopleGeneralPolicySourceTx} from './people-general-policy-source';
import {PeopleGeneralPolicyAvailability} from '../../lib/assistant-actions/people-general-policy-view';
export async function readPeopleGeneralPolicyAvailability(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,async tx=>{const fresh=await withAgentActionGuard(tx,ctx,'org.people_general.change','approve'),source=await lockPeopleGeneralPolicySourceTx(tx,fresh);return PeopleGeneralPolicyAvailability.parse({kind:'available',tenantId:source.tenantId,tenantName:source.tenantName,policy:source.policy});});}catch{return{kind:'unavailable' as const};}}
