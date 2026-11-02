import 'server-only';
import { connectorByOrganization } from './store';
/** Public presentation flag only. Never expose directory IDs, credentials or provisioning settings. */
export async function microsoftLoginEnabled(organization:string):Promise<boolean> {
  if(!/^[a-z0-9][a-z0-9-]{1,63}$/.test(organization.trim().toLowerCase()))return false;
  try{return (await connectorByOrganization(organization)).enabled===true;}catch{return false;}
}
