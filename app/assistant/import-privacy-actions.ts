'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {eraseOwnImportEvaluationMetadata} from '@/core/personnel-import-evaluation';

/** Identity-only privacy command. Losing a business grant must not require regaining it to erase
 * one's own preparation metadata. The canonical owner grants no read or employee-write capability. */
export async function eraseImportPreparationHistoryAction(){
 try{const ctx=await getBrowserCommandSession();await eraseOwnImportEvaluationMetadata(ctx);}
 catch{redirect('/assistant?importHistory=unavailable#assistant-privacy');}
 revalidatePath('/assistant');redirect('/assistant?importHistory=erased#assistant-privacy');
}
