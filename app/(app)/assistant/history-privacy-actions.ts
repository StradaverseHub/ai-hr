'use server';
import {randomUUID} from 'node:crypto';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {eraseOwnAssistantHistory} from '@/core/assistant-history-retention';
/** Native Next server action: POST/origin checks stay in the existing framework boundary.
 * No posted user/tenant/subject/retention period is accepted. Login-only after grant revocation.
 */
export async function eraseAssistantHistoryAction(){
 try{await eraseOwnAssistantHistory(await getBrowserCommandSession());}catch{redirect('/assistant?historyPrivacy=unavailable#assistant-privacy');}
 // The privacy controls sit at the end of the Assistant home; return there so the outcome is in view.
 revalidatePath('/assistant');redirect(`/assistant?historyPrivacy=retired&chatReset=${randomUUID()}#assistant-privacy`);
}
