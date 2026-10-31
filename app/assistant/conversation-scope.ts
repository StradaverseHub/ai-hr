/** One browser-selected company scope for every Assistant command, history read and clarification.
 * The browser cannot post this value. The authenticated session and owned company filter derive it. */
import type {SessionContext} from '../../db/client';
import {allowedCompanies} from '../../core/read';
import {getScopeIds} from '../../lib/scope';
export async function assistantBrowserConversationScope(session:SessionContext):Promise<string>{
 return JSON.stringify((await getScopeIds((await allowedCompanies(session)).map(company=>company.id))).sort());
}
