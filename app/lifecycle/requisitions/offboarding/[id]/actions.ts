'use server';
import {requireModule} from '@/lib/authz';
import {updateOffboardingRequisitionItem} from '@/packs/lifecycle/service';
import {revalidatePath} from 'next/cache';
export async function updateRequisitionItem(input:Parameters<typeof updateOffboardingRequisitionItem>[1]){
 try{const detail=await updateOffboardingRequisitionItem(await requireModule('lifecycle'),input);revalidatePath('/lifecycle/v9');revalidatePath('/me/lifecycle');revalidatePath('/tasks');revalidatePath('/lifecycle/requisitions/offboarding/'+input.caseId);return{ok:true as const,detail};}
 catch{return{ok:false as const};}
}
