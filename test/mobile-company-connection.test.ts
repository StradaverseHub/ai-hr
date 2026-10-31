import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyCompanyProfile } from '../mobile/lib/company-profile';
import { createConnectionState } from '../mobile/lib/connection-state';
import { verifyCompanyServer } from '../mobile/lib/connection-probe';
import { connectionEndpoints, type CompanyProfile } from '../lib/mobile-connection';
import { GET } from '../app/(auth)/login/mobile-connection/route';
import { createAuthState } from '../mobile/lib/auth-state';
import { SessionChangedError } from '../mobile/lib/errors';
const now=Math.floor(Date.now()/1000);
const keys=generateKeyPairSync('ed25519');
const trust=[{keyId:'operator',publicKey:keys.publicKey.export({format:'jwk'}).x!}];
const base:CompanyProfile={id:'private-company',name:'Example company',hosting:'on-premise',notBefore:now-60,expiresAt:now+86400,connectionVersion:1,apiVersion:'v1',authProvider:'keycloak',apiOrigin:'https://hr.private.test',issuer:'https://login.private.test/realms/company',clientId:'aihr-mobile',audience:'aihr-api'};
function signed(profile:unknown=base,key=keys.privateKey,keyId='operator') {const bytes=Buffer.from(JSON.stringify(profile));return JSON.stringify({keyId,payload:bytes.toString('base64url'),signature:sign(null,bytes,key).toString('base64url')});}
const verified=()=>verifyCompanyProfile(signed(),trust);
describe('trusted mobile company profiles',()=>{
 it('accepts an offline signed private installation without any hosted directory',()=>{expect(verified()).toMatchObject(base);});
 it('refuses a self-signed file whose key was not installed in the app',()=>{const foreign=generateKeyPairSync('ed25519');expect(()=>verifyCompanyProfile(signed(base,foreign.privateKey,'foreign'),trust)).toThrow(/not approved/);});
 it('refuses changed endpoints under a valid original signature',()=>{const envelope=JSON.parse(signed());envelope.payload=Buffer.from(JSON.stringify({...base,apiOrigin:'https://attacker.test'})).toString('base64url');expect(()=>verifyCompanyProfile(JSON.stringify(envelope),trust)).toThrow(/signature/);});
 it.each([{expiresAt:now-1},{notBefore:now+60},{apiOrigin:'http://hr.test'},{apiOrigin:'https://hr.test/path'},{issuer:'https://name:password@login.test/realms/x'},{issuer:'https://login.test/realms/x?next=evil'},{apiVersion:'v99'},{tenantId:'untrusted-tenant'},{clientId:'bad\nclient'},{expiresAt:now+400*86400}])('refuses unsupported, expired or unsafe profile %j',patch=>{expect(()=>verifyCompanyProfile(signed({...base,...patch}),trust)).toThrow();});
 it('does not accept a trust key embedded in the setup file',()=>{expect(()=>verifyCompanyProfile(JSON.stringify({...JSON.parse(signed()),publicKey:trust[0].publicKey}),trust)).toThrow();});
 it('bounds the signed input before parsing',()=>{expect(()=>verifyCompanyProfile(' '.repeat(16_385),trust)).toThrow(/too large/);});
});
function controller() {
 const events:string[]=[];let applied:unknown=null;let stored:string|null=null;
 const ports={read:vi.fn(async()=>stored),write:vi.fn(async(raw:string)=>{events.push('write');stored=raw;}),verify:(raw:string)=>verifyCompanyProfile(raw,trust),clearSession:vi.fn(async()=>{events.push('session');}),clearFiles:vi.fn(async()=>{events.push('files');}),apply:vi.fn((p:unknown)=>{events.push('apply');applied=p;})};
 const state=createConnectionState(ports);
 return {state,ports,events,applied:()=>applied,stored:()=>stored};
}
describe('installation switching',()=>{
 it('closes private views immediately, then clears credentials/files before changing endpoints',async()=>{const f=controller();await f.state.initialize();f.events.length=0;let release!:()=>void;f.ports.clearSession.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));const pending=f.state.select(signed());expect(f.state.getSnapshot().status).toBe('switching');expect(f.applied()).toBeNull();release();await pending;expect(f.events).toEqual(['files','write','apply']);expect(f.state.getSnapshot()).toMatchObject({status:'ready',generation:1});expect(f.applied()).toMatchObject(base);});
 it.each(['clearSession','clearFiles','write'] as const)('fails closed when %s fails',async port=>{const f=controller();await f.state.initialize();f.ports[port].mockRejectedValueOnce(new Error('OS failure'));await expect(f.state.select(signed())).rejects.toThrow(/could not finish/);expect(f.state.getSnapshot().status).toBe('error');expect(f.applied()).toBeNull();});
 it('rejects an untrusted file without disrupting the active installation',async()=>{const f=controller();await f.state.initialize();expect(()=>f.state.select('{}')).toThrow();expect(f.ports.clearSession).not.toHaveBeenCalled();expect(f.state.getSnapshot().status).toBe('ready');});
 it('restores only a currently valid signed connection after cold launch',async()=>{const f=controller();f.ports.read.mockResolvedValue(signed());await f.state.initialize();expect(f.applied()).toMatchObject(base);expect(f.ports.read).toHaveBeenCalledTimes(1);await f.state.initialize();expect(f.ports.read).toHaveBeenCalledTimes(1);});
 it('expired persisted setup cannot reopen a previous session',async()=>{const f=controller();f.ports.read.mockResolvedValue(signed({...base,expiresAt:now-1}));await f.state.initialize();expect(f.applied()).toBeNull();expect(f.state.getSnapshot().status).toBe('error');});
 it('an old deployment refresh cannot write credentials after switching companies',async()=>{
   let release!:(pair:{access_token:string;refresh_token:string})=>void;let saved:string|null='old-refresh';
   const authenticate=vi.fn(()=>new Promise<{access_token:string;refresh_token:string}>(r=>{release=r;}));
   const auth=createAuthState({read:async()=>saved,write:async token=>{saved=token;},remove:async()=>{saved=null;},authenticate});
   const pending=auth.refresh().catch(e=>e);await vi.waitFor(()=>expect(authenticate).toHaveBeenCalledTimes(1));
   const f=controller();f.ports.clearSession.mockImplementation(auth.signOut);await f.state.initialize();await f.state.select(signed());
   release({access_token:'old-access',refresh_token:'late-old-refresh'});
   expect(await pending).toBeInstanceOf(SessionChangedError);expect(saved).toBeNull();
 });
});
describe('public enrollment capability checks',()=>{
 it('embedded cloud and private profiles verify the same HR origin without OIDC discovery',async()=>{
  for(const hosting of ['cloud','on-premise'] as const){
   const profile={...base,hosting,authProvider:'internal',issuer:base.apiOrigin+'/auth'};
   const verifiedProfile=verifyCompanyProfile(signed(profile),trust);
   const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json(profile));
   await verifyCompanyServer(verifiedProfile,fetcher);
   expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][0]).toBe(base.apiOrigin+'/login/mobile-connection');
  }
  expect(()=>verifyCompanyProfile(signed({...base,authProvider:'internal',issuer:'https://foreign.test/auth'}),trust)).toThrow();
 });
 it('checks exact server and discovery settings without credentials',async()=>{const p=verified(),e=connectionEndpoints(p);const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(p)).mockResolvedValueOnce(Response.json({issuer:p.issuer,authorization_endpoint:e.authorizationEndpoint,token_endpoint:e.tokenEndpoint,end_session_endpoint:e.logoutEndpoint,code_challenge_methods_supported:['S256']}));await verifyCompanyServer(p,fetcher);expect(fetcher.mock.calls.map(c=>c[0])).toEqual([p.apiOrigin+'/login/mobile-connection',p.issuer+'/.well-known/openid-configuration']);for(const [,init]of fetcher.mock.calls){expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');expect(init?.headers).toBeUndefined();}});
 it('refuses a server with a different identity issuer before following discovery',async()=>{const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({...base,issuer:'https://attacker.test/realms/x'}));await expect(verifyCompanyServer(verified(),fetcher)).rejects.toThrow(/differ/);expect(fetcher).toHaveBeenCalledTimes(1);});
 it('reports unactivated server sign-in and never opens an identity request',async()=>{const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({error:'login_unavailable'},{status:503}));await expect(verifyCompanyServer(verified(),fetcher)).rejects.toThrow(/not activated/);expect(fetcher).toHaveBeenCalledTimes(1);});
 it('rejects an identity endpoint redirect or absent PKCE support in discovery',async()=>{const p=verified(),e=connectionEndpoints(p);for(const changed of [{token_endpoint:'https://attacker.test/token'},{code_challenge_methods_supported:['plain']}]){const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(p)).mockResolvedValueOnce(Response.json({issuer:p.issuer,authorization_endpoint:e.authorizationEndpoint,token_endpoint:e.tokenEndpoint,end_session_endpoint:e.logoutEndpoint,code_challenge_methods_supported:['S256'],...changed}));await expect(verifyCompanyServer(p,fetcher)).rejects.toThrow(/does not match/);}});
 it('publishes only operator configuration, never request-supplied tenant or secret data',async()=>{vi.stubEnv('AUTH_PROVIDER','keycloak');vi.stubEnv('ALLOW_DEMO_SESSION','false');const env={KEYCLOAK_ISSUER:base.issuer,AUTH_PUBLIC_ORIGIN:base.apiOrigin,KEYCLOAK_WEB_CLIENT_ID:'web',KEYCLOAK_WEB_CLIENT_SECRET:'private-secret',KEYCLOAK_MOBILE_CLIENT_ID:base.clientId,KEYCLOAK_API_AUDIENCE:base.audience,AUTH_SESSION_KEY:'a'.repeat(64)};for(const[k,v]of Object.entries(env))vi.stubEnv(k,v);try{const r=await GET();expect(r.status).toBe(200);const text=await r.text();expect(text).not.toContain('private-secret');expect(Object.keys(JSON.parse(text)).sort()).toEqual(['apiOrigin','apiVersion','audience','authProvider','clientId','connectionVersion','issuer']);expect(r.headers.get('cache-control')).toBe('no-store');vi.stubEnv('ALLOW_DEMO_SESSION','true');expect((await GET()).status).toBe(503);}finally{vi.unstubAllEnvs();}});
});

import shippedTrust from '../mobile/connections/trust.json';
import shippedCatalogue from '../mobile/connections/profiles.json';
import { CompanySetupError } from '../mobile/lib/company-profile';
describe('the built-in company catalogue', () => {
  // Judged at each profile's own notBefore, so this does not start failing on a calendar date.
  it('ships only profiles signed by a shipped trust anchor, each naming the staging server and its organization', () => {
    expect(shippedCatalogue.length).toBeGreaterThan(0);
    for (const entry of shippedCatalogue) {
      const raw = JSON.stringify(entry), claimed = JSON.parse(Buffer.from(entry.payload, 'base64url').toString()) as CompanyProfile;
      const profile = verifyCompanyProfile(raw, shippedTrust, claimed.notBefore);
      expect(profile).toMatchObject({ apiOrigin: 'https://onehr-staging.chinhingroup.com', organization: 'aihr-test', authProvider: 'internal' });
    }
    expect(shippedCatalogue.map(e => e.keyId).every(id => shippedTrust.some(k => k.keyId === id))).toBe(true);
  });
  it('no longer trusts the retired key whose private half is lost', () => {
    expect(shippedTrust.map(k => k.keyId)).toEqual(['aihr-test-2026-10b']);
    expect(JSON.stringify(shippedCatalogue)).not.toContain('aihr-test-2026-10"');
  });
  it('says why a setup is refused', () => {
    const at = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof CompanySetupError ? [e.problem, e.at] : e; } };
    const entry = shippedCatalogue[0], claimed = JSON.parse(Buffer.from(entry.payload, 'base64url').toString()) as CompanyProfile;
    expect(at(() => verifyCompanyProfile(JSON.stringify(entry), shippedTrust, claimed.expiresAt))).toEqual(['expired', claimed.expiresAt]);
    expect(at(() => verifyCompanyProfile(JSON.stringify(entry), shippedTrust, claimed.notBefore - 1))).toEqual(['not_yet_valid', claimed.notBefore]);
    expect(at(() => verifyCompanyProfile(JSON.stringify(entry), []))).toEqual(['untrusted', undefined]);
    expect(at(() => verifyCompanyProfile('not json', shippedTrust))).toEqual(['not_setup', undefined]);
    expect(at(() => verifyCompanyProfile(JSON.stringify({ ...entry, signature: entry.signature.replace(/^./, c => c === 'A' ? 'B' : 'A') }), shippedTrust, claimed.notBefore))).toEqual(['bad_signature', undefined]);
  });
});
