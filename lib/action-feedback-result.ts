import {isRedirectError} from 'next/dist/client/components/redirect-error';

/** Only a redirect already accepted by Next is navigation, rather than an unknown write result. */
export function isHandledActionRedirect(error:unknown):boolean {
 return isRedirectError(error)&&'handled' in error&&error.handled===true;
}
