'use server';
import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {admitProbation,actOnProbation,saveProbationDraft,logProbationFollowup,saveProbationConfiguration,installProbationDrafts,bootstrapProbationPreparer,assignProbationAccess,replaceProbationSigner,overrideProbationRoute,saveProbationLetterTemplate,previewProbationLetter,prepareProbationLetter,actOnProbationLetter,releaseProbationLetter,saveProbationWorkflow,previewProbationWorkflow,requestProbationDateShift,applyProbationDateShift,reconcileProbationDates,saveProbationIntakeDisposition,prepareProbationCutoverPlan,approveProbationCutover,supersedeProbationDateShift,proposeProbationOfflineFinalDecision,adjudicateProbationOfflineFinalDecision,probationPublicationRetirement,retireProbationPublication,requestProbationLegacyReconciliation,approveProbationLegacyReconciliation} from '@/packs/probation/service';
async function execute<T>(work:()=>Promise<T>){
 try{const result=await work();revalidatePath('/lifecycle/probation','layout');return{ok:true as const,result};}
 catch(error){return{ok:false as const,code:error instanceof Error&&error.name==='ProbationError'?'review':'unavailable',detail:error instanceof Error&&error.name==='ProbationError'?error.message:undefined};}
}
export async function saveDraft(input:Parameters<typeof saveProbationDraft>[1]){return execute(async()=>saveProbationDraft(await requireScopedLifecycleModule(),input));}
export async function performReview(input:Parameters<typeof actOnProbation>[1]){return execute(async()=>actOnProbation(await requireScopedLifecycleModule(),input));}
export async function addFollowup(input:Parameters<typeof logProbationFollowup>[1]){return execute(async()=>logProbationFollowup(await requireScopedLifecycleModule(),input));}
export async function saveConfiguration(input:Parameters<typeof saveProbationConfiguration>[1]){return execute(async()=>saveProbationConfiguration(await requireScopedLifecycleModule(),input));}
export async function prepareDefaults(companyId:string){return execute(async()=>installProbationDrafts(await requireScopedLifecycleModule(),companyId));}
export async function admitCase(input:Parameters<typeof admitProbation>[1]){return execute(async()=>admitProbation(await requireScopedLifecycleModule(),input));}
export async function bootstrapPreparer(input:Parameters<typeof bootstrapProbationPreparer>[1]){return execute(async()=>bootstrapProbationPreparer(await requireScopedLifecycleModule(),input));}
export async function assignAccess(input:Parameters<typeof assignProbationAccess>[1]){return execute(async()=>assignProbationAccess(await requireScopedLifecycleModule(),input));}
export async function replaceSigner(input:Parameters<typeof replaceProbationSigner>[1]){return execute(async()=>replaceProbationSigner(await requireScopedLifecycleModule(),input));}
export async function overrideRoute(input:Parameters<typeof overrideProbationRoute>[1]){return execute(async()=>overrideProbationRoute(await requireScopedLifecycleModule(),input));}

export async function saveLetterTemplate(input:Parameters<typeof saveProbationLetterTemplate>[1]){return execute(async()=>saveProbationLetterTemplate(await requireScopedLifecycleModule(),input));}

export async function previewLetter(input:Parameters<typeof previewProbationLetter>[1]){return execute(async()=>previewProbationLetter(await requireScopedLifecycleModule(),input));}

export async function prepareLetter(input:Parameters<typeof prepareProbationLetter>[1]){return execute(async()=>prepareProbationLetter(await requireScopedLifecycleModule(),input));}

export async function signLetter(input:Parameters<typeof actOnProbationLetter>[1]){return execute(async()=>actOnProbationLetter(await requireScopedLifecycleModule(),input));}

export async function releaseLetter(input:Parameters<typeof releaseProbationLetter>[1]){return execute(async()=>releaseProbationLetter(await requireScopedLifecycleModule(),input));}

export async function saveWorkflow(input:Parameters<typeof saveProbationWorkflow>[1]){return execute(async()=>saveProbationWorkflow(await requireScopedLifecycleModule(),input));}

export async function previewWorkflow(input:Parameters<typeof previewProbationWorkflow>[1]){return execute(async()=>previewProbationWorkflow(await requireScopedLifecycleModule(),input));}

export async function requestDateShift(input:Parameters<typeof requestProbationDateShift>[1]){return execute(async()=>requestProbationDateShift(await requireScopedLifecycleModule(),input));}

export async function applyDateShift(input:Parameters<typeof applyProbationDateShift>[1]){return execute(async()=>applyProbationDateShift(await requireScopedLifecycleModule(),input));}

export async function reconcileDates(input:Parameters<typeof reconcileProbationDates>[1]){return execute(async()=>reconcileProbationDates(await requireScopedLifecycleModule(),input));}

export async function stageIntake(input:Parameters<typeof saveProbationIntakeDisposition>[1]){return execute(async()=>saveProbationIntakeDisposition(await requireScopedLifecycleModule(),input));}
export async function prepareCutover(companyId:string){return execute(async()=>prepareProbationCutoverPlan(await requireScopedLifecycleModule(),companyId));}
export async function approveCutover(input:Parameters<typeof approveProbationCutover>[1]){return execute(async()=>{await approveProbationCutover(await requireScopedLifecycleModule(),input);return{approved:true};});}

export async function supersedeDateShift(input:Parameters<typeof supersedeProbationDateShift>[1]){return execute(async()=>{await supersedeProbationDateShift(await requireScopedLifecycleModule(),input);return{closed:true};});}
export async function proposeOfflineFinal(input:Parameters<typeof proposeProbationOfflineFinalDecision>[1]){return execute(async()=>proposeProbationOfflineFinalDecision(await requireScopedLifecycleModule(),input));}
export async function adjudicateOfflineFinal(input:Parameters<typeof adjudicateProbationOfflineFinalDecision>[1]){return execute(async()=>adjudicateProbationOfflineFinalDecision(await requireScopedLifecycleModule(),input));}

export async function readPublicationRetirement(input:Parameters<typeof probationPublicationRetirement>[1]){
 try{return{ok:true as const,result:await probationPublicationRetirement(await requireScopedLifecycleModule(),input)};}
 catch(error){return{ok:false as const,detail:error instanceof Error&&error.name==='ProbationError'?error.message:undefined};}
}
export async function retirePublication(input:Parameters<typeof retireProbationPublication>[1]){return execute(async()=>retireProbationPublication(await requireScopedLifecycleModule(),input));}

export async function requestLegacyReconciliation(input:Parameters<typeof requestProbationLegacyReconciliation>[1]){return execute(async()=>requestProbationLegacyReconciliation(await requireScopedLifecycleModule(),input));}
export async function approveLegacyReconciliation(input:Parameters<typeof approveProbationLegacyReconciliation>[1]){return execute(async()=>{await approveProbationLegacyReconciliation(await requireScopedLifecycleModule(),input);return{approved:true};});}
