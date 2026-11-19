/** One browser-selected company scope for every Assistant command, history read and clarification.
 * The browser cannot post this value. The authenticated session and owned company filter derive it. */
import type {SessionContext} from '../../db/client';
import {companyContextForPage} from '../../lib/scope';
export async function assistantBrowserConversationScope(session:SessionContext):Promise<string>{
 // The shell can reuse this read within the same render. Each command still supplies its own authenticated session.
 const {scopeIds}=await companyContextForPage(session);
 return JSON.stringify([...scopeIds].sort());
}
