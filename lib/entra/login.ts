import * as oidc from 'openid-client';
import { createHash } from 'node:crypto';
import { client } from '../../db/client';
import { authTransaction, readRecord, writeRecord, deleteRecord } from '../internal-auth/store';
import { opaque, digest, validOpaque } from '../internal-auth/crypto';
import { internalConfig } from '../internal-auth/config';
import { safeReturnTo } from '../identity/config';
import { connector, connectorByOrganization, assertConnector } from './store';
import { EntraError, issuerFor, nativeRedirect, type EntraConfig } from './model';
import { createEntraSession } from './sessions';
type Native = { redirect:string; state:string; challenge:string };
type Flow = { tenantId:string; revision:string; verifier:string; state:string; nonce:string; returnTo:string; native?:Native };
export const ENTRA_FLOW_COOKIE='__Host-aihr_entra';
export const callbackUri=()=>internalConfig().origin+'/login/entra/callback';
export async function oidcConfiguration(config:EntraConfig) {
  const value=await oidc.discovery(new URL(issuerFor(config.directoryTenantId)),config.clientId,{token_endpoint_auth_method:'client_secret_post'},oidc.ClientSecretPost(config.clientSecret),{timeout:10});
  const metadata=value.serverMetadata();
  if(metadata.issuer!==issuerFor(config.directoryTenantId))throw new EntraError('invalid');
  // Microsoft discovery includes cross-tenant endpoints; only this trusted host may receive credentials.
  for(const key of ['authorization_endpoint','token_endpoint','jwks_uri'] as const) {
    const url=new URL(String(metadata[key]));
    if(url.origin!=='https://login.microsoftonline.com'||url.username||url.password||url.hash)throw new EntraError('invalid');
  }
  return value;
}
export async function nativeLaunch(organization:string, native:Native) {
  nativeRedirect(native.redirect);
  if(!/^[A-Za-z0-9_-]{43}$/.test(native.challenge)||!/^[A-Za-z0-9_-]{16,128}$/.test(native.state))throw new EntraError('invalid');
  const config=await connectorByOrganization(organization), ticket=opaque();
  await writeRecord(client,`entra-launch:${digest(ticket)}`,{tenantId:config.tenantId,revision:config.revision,native},null,Date.now()+120_000);
  return internalConfig().origin+'/login/entra/start?ticket='+ticket;
}
export async function startEntraLogin(organization:string,returnTo:string,ticket?:string) {
  let native:Native|undefined, config:EntraConfig|null;
  if(ticket){
    if(!validOpaque(ticket))throw new EntraError('invalid');
    const launch=await authTransaction(`entra-launch:${digest(ticket)}`,async tx=>{
      const key=`entra-launch:${digest(ticket)}`,value=await readRecord<{tenantId:string;revision:string;native:Native}>(tx,key,true);
      if(!value)throw new EntraError('invalid');await deleteRecord(tx,key);return value;
    });
    config=await connector(launch.tenantId);native=launch.native;
    if(!config?.enabled||config.revision!==launch.revision)throw new EntraError('forbidden');
  }else config=await connectorByOrganization(organization);
  const library=await oidcConfiguration(config),handle=opaque();
  const flow:Flow={tenantId:config.tenantId,revision:config.revision,verifier:oidc.randomPKCECodeVerifier(),state:oidc.randomState(),nonce:oidc.randomNonce(),returnTo:safeReturnTo(returnTo),...(native?{native}: {})};
  const url=oidc.buildAuthorizationUrl(library,{redirect_uri:callbackUri(),scope:'openid profile',response_type:'code',state:flow.state,nonce:flow.nonce,code_challenge:await oidc.calculatePKCECodeChallenge(flow.verifier),code_challenge_method:'S256'});
  await writeRecord(client,`entra-flow:${digest(handle)}`,flow,null,Date.now()+600_000);
  return {handle,url:url.href};
}
export async function completeEntraLogin(handle:string|undefined,received:URL) {
  if(!validOpaque(handle))throw new EntraError('invalid');
  // Claim before external exchange. Failure consumes this attempt; concurrent callback replay is refused.
  const flow=await authTransaction(`entra-flow:${digest(handle!)}`,async tx=>{
    const key=`entra-flow:${digest(handle!)}`,value=await readRecord<Flow>(tx,key,true);
    if(!value)throw new EntraError('invalid');await deleteRecord(tx,key);return value;
  });
  const config=await connector(flow.tenantId);
  if(!config||!config.enabled||config.revision!==flow.revision)throw new EntraError('forbidden');
  const url=new URL(callbackUri());url.search=received.search;
  const tokens=await oidc.authorizationCodeGrant(await oidcConfiguration(config),url,{pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce,idTokenExpected:true});
  const claims=tokens.claims(),object=claims?.oid;
  if(claims?.tid!==config.directoryTenantId||typeof object!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(object))throw new EntraError('forbidden');
  await assertConnector(config);
  if(flow.native){
    const code=opaque();
    // Do not create a session until the native proof is consumed. No bearer tokens enter the deep link.
    await writeRecord(client,`entra-completion:${digest(code)}`,{tenantId:config.tenantId,revision:config.revision,objectId:object.toLowerCase(),challenge:flow.native.challenge},null,Date.now()+60_000);
    const redirect=new URL(nativeRedirect(flow.native.redirect));redirect.searchParams.set('code',code);redirect.searchParams.set('state',flow.native.state);
    return {native:true as const,redirect:redirect.href};
  }
  return {native:false as const,redirect:new URL(flow.returnTo,internalConfig().origin).href,tokens:await createEntraSession(config,object.toLowerCase(),false)};
}
export async function exchangeNative(code:string,verifier:string) {
  if(!validOpaque(code)||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))throw new EntraError('invalid');
  const value=await authTransaction(`entra-completion:${digest(code)}`,async tx=>{
    const key=`entra-completion:${digest(code)}`,value=await readRecord<{tenantId:string;revision:string;objectId:string;challenge:string}>(tx,key,true);
    if(!value||createHash('sha256').update(verifier).digest('base64url')!==value.challenge)throw new EntraError('forbidden');
    await deleteRecord(tx,key);return value;
  });
  const config=await connector(value.tenantId);
  if(!config||config.revision!==value.revision)throw new EntraError('forbidden');
  return createEntraSession(config,value.objectId,true);
}
