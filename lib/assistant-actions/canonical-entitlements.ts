/** PRIVATE DIGEST INPUT ONLY. Never use this projection to make or refresh a permission decision.
 * Commercial module/company collections are sets; setting arrays retain their declared order.
 * Clone first so no returned object or array can mutate the caller's authority snapshot. */
import type {EntitlementSnapshot} from '../../core/entitlement-types';
function orderedObjects(value:unknown):unknown{
 if(Array.isArray(value))return value.map(orderedObjects);
 if(value!==null&&typeof value==='object'){
  const prototype=Object.getPrototypeOf(value);
  if(prototype===Object.prototype||prototype===null)return Object.fromEntries(Object.keys(value).sort().map(key=>[key,orderedObjects((value as Record<string,unknown>)[key])]));
 }
 // Resolved settings are JSON-backed. Preserve any other cloned value rather than coercing it.
 return value;
}
export function canonicalEntitlementsForDigest(snapshot:EntitlementSnapshot|undefined):EntitlementSnapshot|undefined{
 if(snapshot===undefined)return undefined;
 const copy=structuredClone(snapshot);
 return{tenantId:copy.tenantId,enabledModules:[...new Set(copy.enabledModules)].sort(),
  scopedModules:Object.fromEntries(Object.keys(copy.scopedModules).sort().map(code=>[code,[...new Set(copy.scopedModules[code])].sort()])),
  settings:orderedObjects(copy.settings) as Record<string,unknown>,tenantStatus:copy.tenantStatus};
}
