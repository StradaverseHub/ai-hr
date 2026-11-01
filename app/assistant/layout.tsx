import {routeMessageLayout} from '@/components/route-messages';
import type {ReactNode} from 'react';
import {redirect} from 'next/navigation';
import {getBrowserCommandSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
/** Authentication for the shared Assistant shell and every human review page. Individual grants,
 * modules, pauses, native permissions and source facts remain freshly checked by their owners.
 * A signed-in owner can still find/discard saved review metadata after an effect grant is revoked. */
async function AssistantLayout({children}:{children:ReactNode}){
 try{const session=await getBrowserCommandSession();if(!session.userId)throw new AuthRequiredError('No active session.');}
 catch(error){if(error instanceof AuthRequiredError)redirect('/login');throw error;}
 return children;
}

export default routeMessageLayout('assistant',AssistantLayout);
