/** Issue one invitation on the disposable browser fixture without external email delivery. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const env=process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests');
assert(env.PERF_HTTP_SUITE==='browser-route-baseline'&&env.AUTH_PROVIDER==='internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');

async function source(file){
 const module=await import(pathToFileURL(resolve(file)).href);
 return {...module.default,...module};
}

const fixturePath=resolve(env.PERF_PRIVATE_DIR,'fixture.json');
const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const [group]=fixture.users;
const employee=fixture.users[4];
assert(fixture.users.length===500&&fixture.tenants.length===2);
assert(group.role==='groupHR'&&employee.role==='employee'&&group.tenantId===employee.tenantId);
const {client,createDb}=await source('db/client.ts');
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
try{
 const {inviteUser}=await source('core/auth.ts');
 const grants=await owner.client`
  select role,company_id as "companyId" from role_assignment
  where tenant_id=${group.tenantId}::uuid and app_user_id=${group.userId}::uuid
 `;
 assert(grants.some(grant=>grant.role==='hr_admin'&&grant.companyId===null));
 const session={tenantId:group.tenantId,userId:group.userId,personId:group.personId,
  grants,roles:[...new Set(grants.map(grant=>grant.role))]};
 const refuseMail=async()=>{throw new Error('Fictional fixture has no outbound mail transport');};
 fixture.invitationRecord=await inviteUser(session,{email:'person'+employee.index+'@example.invalid',
  personId:employee.personId,companyId:employee.companyId,role:'employee'},{
  emailReadiness:async()=> 'providerUnavailable',
  sendInvitation:refuseMail,revokeInvitation:refuseMail,sendPasswordReset:refuseMail,endSession:refuseMail,
 });
 assert(/^[A-Za-z0-9_-]{43}$/.test(fixture.invitationRecord.token));
 writeFileSync(fixturePath,JSON.stringify(fixture),{mode:0o600});
}finally{
 await Promise.all([owner.client.end({timeout:5}),client.end({timeout:5})]);
}
