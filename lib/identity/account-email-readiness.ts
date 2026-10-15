import {keycloakReady,keycloakSelected} from './config';
import {missingWorkosSettings} from '../real-auth';
import type {AccountEmailReadiness} from '../account-email-model';

/** The deployed provider always checks SMTP; injected test providers may declare their own readiness. */
export async function accountEmailReadiness():Promise<AccountEmailReadiness>{
 try{
  const {identityEmailRequest}=await import('./email-ipc');
  if(!(await identityEmailRequest<{ready:boolean}>({op:'readiness'})).ready)return 'relayUnavailable';
 }catch{return 'relayUnavailable';}
 if(keycloakSelected())return keycloakReady()&&process.env.KEYCLOAK_EMAIL_ENABLED==='true'&&!!process.env.KEYCLOAK_ADMIN_CLIENT_ID&&!!process.env.KEYCLOAK_ADMIN_CLIENT_SECRET?null:'providerUnavailable';
 return missingWorkosSettings().length?'providerUnavailable':null;
}

