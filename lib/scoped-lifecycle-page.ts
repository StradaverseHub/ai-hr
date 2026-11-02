import {redirect} from 'next/navigation';
import {getSession} from './session';
import {isModuleEnabled} from '@/core/entitlements';
/** Courtesy gate for the new company-scoped modules; each service checks its actual company. */
export async function requireScopedLifecycleModule(){
 const ctx=await getSession();if(ctx.entitlements==null)return ctx;
 if(ctx.entitlementsExempt!==undefined||isModuleEnabled(ctx,'lifecycle')||(ctx.entitlements.scopedModules.lifecycle??[]).some(companyId=>isModuleEnabled(ctx,'lifecycle',companyId)))return ctx;
 redirect('/?moduleUnavailable=lifecycle');
}
