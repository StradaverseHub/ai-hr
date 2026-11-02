'use server';
import {randomUUID} from 'node:crypto';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {eraseOwnAssistantHistory} from '@/core/assistant-history-retention';
import {eraseOwnChats} from '@/core/teras-chats';
/** Native Next server action: POST/origin checks stay in the existing framework boundary.
 * No posted user/tenant/subject/retention period is accepted. Login-only after grant revocation.
 * "Clear my chat text" also erases the login's stored AI Centre chats (migration 0952) with their task memory. Both
 * erasures are idempotent, so a failure of either reports unavailable and a retry completes the other.
 */
export async function eraseAssistantHistoryAction(){
 try{const session=await getBrowserCommandSession();await eraseOwnChats(session);await eraseOwnAssistantHistory(session);}catch{redirect('/assistant?historyPrivacy=unavailable#assistant-privacy');}
 // The privacy controls sit at the end of the Assistant home; return there so the outcome is in view.
 revalidatePath('/assistant');redirect(`/assistant?historyPrivacy=retired&chatReset=${randomUUID()}#assistant-privacy`);
}
