import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as schema from '../db/schema';
const state=vi.hoisted(()=>({ctx:{} as Record<string,unknown>,identity:{} as Record<string,unknown>}));
vi.mock('../lib/session',()=>({getSession:async()=>state.ctx}));
vi.mock('../lib/identity/session',()=>({currentIdentitySession:async()=>state.identity}));
import {requireManualIdentityAdmin} from '../lib/identity/manual-admin';
const issuer='https://hr.test/identity/realms/ai-hr';let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();base=await seedBase();state.ctx=adminCtx(base) as unknown as Record<string,unknown>;
 state.identity={issuer,subject:'linked-admin',emailVerified:true};
 await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:'linked-admin',appUserId:base.adminUserId});
 for(const [k,v]of Object.entries({AUTH_PROVIDER:'keycloak',AUTH_PUBLIC_ORIGIN:'https://hr.test',KEYCLOAK_ISSUER:issuer,
  KEYCLOAK_WEB_CLIENT_ID:'web',KEYCLOAK_WEB_CLIENT_SECRET:'secret',KEYCLOAK_MOBILE_CLIENT_ID:'mobile',KEYCLOAK_API_AUDIENCE:'api',AUTH_SESSION_KEY:'f'.repeat(64)}))vi.stubEnv(k,v);
});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
describe('manual account administrator — live identity binding',()=>{
 it('accepts only the exact server-session issuer/subject bound to the current tenant administrator',async()=>{
  expect((await requireManualIdentityAdmin()).userId).toBe(base.adminUserId);
  for(const change of [{subject:'unbound'},{issuer:'https://other.test/realms/hr'},{emailVerified:false}]){
   const prev={...state.identity};Object.assign(state.identity,change);
   await expect(requireManualIdentityAdmin()).rejects.toMatchObject({code:'forbidden'});state.identity=prev;
  }
 });
 it('rejects a valid session from another internal account and stale group-administrator grants',async()=>{
  const other=await seedBase();await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:'other-admin',appUserId:other.adminUserId});
  state.identity.subject='other-admin';await expect(requireManualIdentityAdmin()).rejects.toMatchObject({code:'forbidden'});
  state.identity.subject='linked-admin';await owner.db.update(schema.roleAssignment).set({companyId:base.companyId}).where(eq(schema.roleAssignment.appUserId,base.adminUserId));
  await expect(requireManualIdentityAdmin()).rejects.toMatchObject({code:'forbidden'});
 });
 it('refuses demo and WorkOS modes even when the internal user has administrator grants',async()=>{
  vi.stubEnv('AUTH_PROVIDER','');await expect(requireManualIdentityAdmin()).rejects.toMatchObject({code:'forbidden'});
  vi.stubEnv('AUTH_PROVIDER','workos');await expect(requireManualIdentityAdmin()).rejects.toMatchObject({code:'forbidden'});
 });
});
