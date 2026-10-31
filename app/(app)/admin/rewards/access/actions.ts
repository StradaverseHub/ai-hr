'use server';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { decideRewardAccessRequest,RewardMaintenanceError, previewRewardAccessBatch, previewRewardAccessCopy, saveRewardAccessBatch } from '@/packs/rewards/service';
/** f38e5d8e — multi-review access. The service re-checks authority, eligibility and coverage on every call. */
function failure(error: unknown) {
    return error instanceof RewardMaintenanceError ? { ok: false as const, error: error.code, role: error.role ?? null } : { ok: false as const, error: 'system' as const, role: null };
}
export async function previewRewardAccessBatchAction(input: unknown) {
    try { return { ok: true as const, preview: await previewRewardAccessBatch(await getSession(), input) }; }
    catch (error) { return failure(error); }
}
export async function saveRewardAccessBatchAction(input: unknown, digest: string) {
    try { const result = await saveRewardAccessBatch(await getSession(), input, digest); revalidatePath('/rewards', 'layout'); revalidatePath('/admin/rewards', 'layout'); return { ok: true as const, result }; }
    catch (error) { return failure(error); }
}
export async function previewRewardAccessCopyAction(input: unknown) {
    try { return { ok: true as const, copy: await previewRewardAccessCopy(await getSession(), input) }; }
    catch (error) { return failure(error); }
}

export async function decideRewardAccessRequestAction(requestId:string,approve:boolean,reason:string){
 try{const result=await decideRewardAccessRequest(await getSession(),requestId,approve,reason);revalidatePath('/rewards','layout');revalidatePath('/admin/rewards','layout');return {ok:true as const,result};}
 catch(error){return failure(error);}
}
