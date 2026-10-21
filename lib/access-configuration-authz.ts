import {redirect} from 'next/navigation';
import {getSession} from './session';
import {AccessPermissionError} from './access-permission-model';
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
/** Role names are not the page gate: the transaction checks the real current configure permission. */
export async function requireAccessConfiguration(){
 const session=await getSession();
 try{return {session,data:await readAccessConfigurationEditor(session)};}
 catch(error){if(error instanceof AccessPermissionError&&error.code==='ceiling')redirect('/');throw error;}
}
