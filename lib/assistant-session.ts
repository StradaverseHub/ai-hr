import 'server-only';
import {cookies} from 'next/headers';
import {randomBytes,createHash} from 'node:crypto';
import {getFreshSession} from './session';
import {demoSwitcherEnabled} from './demo-mode';
import {internalSelected,INTERNAL_SESSION_COOKIE} from './internal-auth/config';
import {keycloakSelected,WEB_SESSION_COOKIE} from './identity/config';
import {getScopeIds} from './scope';
import {allowedCompanies} from '../core/read';
import {AssistantConversationError} from './assistant-conversation-model';
import {ASSISTANT_DEMO_NONCE_COOKIE,assistantDemoNonce,assistantSignInFingerprint} from './assistant-signin-model';

/** Called only from conversation-start action, where Next permits a cookie write. The demo nonce
 * partitions history; it cannot authenticate or affect the canonical development principal. */
export async function ensureAssistantDemoNonce():Promise<void> {
 if(!demoSwitcherEnabled())return;
 await getFreshSession();
 const store=await cookies();if(assistantDemoNonce.safeParse(store.get(ASSISTANT_DEMO_NONCE_COOKIE)?.value).success)return;
 store.set(ASSISTANT_DEMO_NONCE_COOKIE,randomBytes(32).toString('base64url'),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/'});
}
/** Provider binding is freshly verified before AND after resolving the real DB principal; do not
 * return or serialize raw cookies, family keys, credentials, token handles or provider session IDs. */
async function signInFingerprint():Promise<string>{
 const store=await cookies();
 if(internalSelected()){
  const value=await (await import('./internal-auth/service')).readSession(store.get(INTERNAL_SESSION_COOKIE)?.value);
  if(!value)throw new AssistantConversationError('sessionUnavailable');
  return assistantSignInFingerprint({provider:'internal',issuer:value.issuer,subject:value.subject,session:value.family});
 }
 if(keycloakSelected()){
  const {currentIdentitySession,sessionHash}=await import('./identity/session');
  const value=await currentIdentitySession(),handle=await (await import('./identity/cookie')).readSessionHandle(store.get(WEB_SESSION_COOKIE)?.value);
  const hash=handle&&sessionHash(handle);if(!value||!hash)throw new AssistantConversationError('sessionUnavailable');
  return assistantSignInFingerprint({provider:'keycloak',issuer:value.issuer,subject:value.subject,session:hash});
 }
 if(demoSwitcherEnabled()){
  const ctx=await getFreshSession(),nonce=assistantDemoNonce.safeParse(store.get(ASSISTANT_DEMO_NONCE_COOKIE)?.value);
  if(!ctx.userId||!nonce.success)throw new AssistantConversationError('sessionUnavailable');
  return assistantSignInFingerprint({provider:'demo',subject:ctx.userId,session:nonce.data});
 }
 const value=await (await import('./workos')).currentWorkosConversationSession();
 if(!value)throw new AssistantConversationError('sessionUnavailable');
 return assistantSignInFingerprint({provider:'workos',subject:value.subject,session:value.sessionId});
}
export async function resolveAssistantSession(){
 const before=await signInFingerprint(),ctx=await getFreshSession();
 if(!ctx.userId||before!==await signInFingerprint())throw new AssistantConversationError('sessionUnavailable');
 const companies=await allowedCompanies(ctx),scopeIds=await getScopeIds(companies.map(company=>company.id));
 if(scopeIds.length>100)throw new AssistantConversationError('unavailable');
 const selected=[...new Set(scopeIds)].sort();
 return {ctx,signInHash:before,scopeIds:selected,companyNames:companies.filter(company=>selected.includes(company.id)).map(company=>company.name).filter((name):name is string=>typeof name==='string')};
}
export type AssistantSession=Awaited<ReturnType<typeof resolveAssistantSession>>;

/** Opaque React boundary key drops cached client history after an RSC scope/actor refresh. This key
 * conveys no authority; every operation still re-resolves the verified provider session and DB stamp. */
export async function assistantWorkspaceKey(){return (await assistantWorkspaceView()).key;}

export async function assistantWorkspaceView(){const session=await resolveAssistantSession();return {key:createHash('sha256').update(JSON.stringify(['assistant-workspace-v1',session.ctx.tenantId,session.ctx.userId,session.ctx.personId,session.signInHash,session.scopeIds,session.ctx.roles,session.ctx.grants,session.ctx.entitlements])).digest('hex'),companyNames:session.companyNames};}
