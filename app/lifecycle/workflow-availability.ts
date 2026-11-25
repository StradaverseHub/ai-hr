import 'server-only';
import type {SessionContext} from '@/db/client';
import {probationNavigationAccess} from '@/packs/probation/service';
import {contractNavigationAccess} from '@/packs/contracts/service';
import {v9WorkflowNavigationAllowed} from '@/packs/lifecycle/service';
import {perRenderRead} from '@/lib/request-memo';
/** The caller's Probation and Contract menu access. Inside a page render it is read once (ADR 0181 queues addendum Q0):
 * the app frame's menu and a page that asks the same question (/tasks, the workflow pages) share one answer. */
export function lifecycleModuleNavigation(ctx:SessionContext){
 return perRenderRead(ctx,'lifecycle-module-navigation',async()=>{
  const [probation,contractStaff]=await Promise.all([probationNavigationAccess(ctx),contractNavigationAccess(ctx)]);return{probation,contractStaff};
 });
}
export async function lifecycleWorkflowAvailability(ctx:SessionContext,legacy?:boolean){
 const [navigation,legacyAllowed]=await Promise.all([lifecycleModuleNavigation(ctx),legacy===undefined?v9WorkflowNavigationAllowed(ctx):Promise.resolve(legacy)]);
 return{legacy:legacyAllowed,probation:navigation.probation.configure,contract_staff:navigation.contractStaff.automation};
}
