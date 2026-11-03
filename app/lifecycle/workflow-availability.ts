import 'server-only';
import type {SessionContext} from '@/db/client';
import {probationNavigationAccess} from '@/packs/probation/service';
import {contractNavigationAccess} from '@/packs/contracts/service';
import {v9WorkflowNavigationAllowed} from '@/packs/lifecycle/service';
export async function lifecycleModuleNavigation(ctx:SessionContext){
 const [probation,contractStaff]=await Promise.all([probationNavigationAccess(ctx),contractNavigationAccess(ctx)]);return{probation,contractStaff};
}
export async function lifecycleWorkflowAvailability(ctx:SessionContext,legacy?:boolean){
 const [navigation,legacyAllowed]=await Promise.all([lifecycleModuleNavigation(ctx),legacy===undefined?v9WorkflowNavigationAllowed(ctx):Promise.resolve(legacy)]);
 return{legacy:legacyAllowed,probation:navigation.probation.configure,contract_staff:navigation.contractStaff.configure};
}
