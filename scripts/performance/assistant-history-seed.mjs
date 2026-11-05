/** Separate server-runtime entry point for the owned CI fixture. Never opens a provider connection. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync,renameSync} from 'node:fs';
import {join} from 'node:path';
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.AUTH_PROVIDER,'internal');
assert.equal(process.env.AUTH_PUBLIC_ORIGIN,'https://localhost:3443');
for(const name of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
 const url=new URL(process.env[name]);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');
 assert.match(url.pathname,/^\/ai_hr_(dev|test(?:_[a-z0-9_]+)?)$/);
}
const path=join(process.env.PERF_PRIVATE_DIR,'fixture.json');
assert.equal(statSync(path).mode&0o077,0,'Saved-chat expectations require a private fixture file.');
const fixture=JSON.parse(readFileSync(path,'utf8'));assert.equal(fixture.tenants.length,2);assert.equal(fixture.assistantHistory,undefined);
const [{client,createDb},{internalIssuer},{seedAssistantHistoryFixture}]=await Promise.all([
 import('../../db/client.ts'),import('../../lib/internal-auth/config.ts'),import('./assistant-history-fixture.ts'),
]);
const owner=createDb(process.env.MIGRATION_DATABASE_URL,{max:1}),assistantHistory={};
try{
 for(const [tenantIndex,tenant]of fixture.tenants.entries())for(const role of ['employee','companyHR']){
  const actor=fixture.users.find(user=>user.tenant===tenantIndex&&user.role===role);assert(actor);
  assistantHistory[actor.index]=await seedAssistantHistoryFixture(owner,{index:actor.index,tenantId:tenant.tenantId,userId:actor.userId,personId:actor.personId,issuer:internalIssuer(tenant.tenantId),subject:actor.subject});
 }
 assert.equal(Object.keys(assistantHistory).length,4);
 const pending=path+'.assistant-history.tmp';writeFileSync(pending,JSON.stringify({...fixture,assistantHistory}),{mode:0o600,flag:'wx'});renameSync(pending,path);
 console.log('[system-perf-fixture] Four owned saved histories inserted and verified in the fixture database.');
}finally{await Promise.all([owner.client.end(),client.end()]);}
