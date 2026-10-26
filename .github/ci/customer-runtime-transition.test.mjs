/** Tiny private configuration fixtures only; no service, app, SSH, database or host install. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePrivateEnvironment,proposeCustomerEnvironment,proposeCustomerUnit,summarizeCustomerProposal} from './customer-runtime-transition.mjs';
const key='a'.repeat(64),env=Buffer.from('# retained comment\nNODE_ENV=production\nAUTH_PROVIDER=internal\nALLOW_DEMO_SESSION=false\nAUTH_SESSION_KEY='+key+'\nAUTH_PUBLIC_ORIGIN=https://hr.customer.org\nPRIVATE_TOKEN="unchanged fixture secret"\nDEV_TENANT_ID=fixture-tenant\nexport DEV_USER_ID=fixture-user\nAUDIT_HASH_CHAIN_ENABLED=false\n');
const descriptor='{ path=/opt/node20/bin/node ; argv[]=/opt/node20/bin/node /opt/ai-hr/node_modules/next/dist/bin/next start -p 3000 ; ignore_errors=no ; }';
const unitInput={descriptor,runtimePath:'/opt/node20/bin:/usr/local/bin:/usr/bin:/bin',environmentFilePathOverrideAbsent:true,ordinaryExecStartProved:true,pathUnsetAbsent:true,auditFlagUnsetAbsent:true};
test('real isolated-shell evaluation permits only exact three-key delta and redacts private values',()=>{
 const e=proposeCustomerEnvironment(env),u=proposeCustomerUnit(unitInput),summary=summarizeCustomerProposal(e,u);
 assert(!e.bytes.toString().includes('DEV_TENANT_ID='));assert(!e.bytes.toString().includes('DEV_USER_ID='));assert(e.bytes.toString().includes('AUDIT_HASH_CHAIN_ENABLED=true\n'));
 assert(e.bytes.toString().includes('PRIVATE_TOKEN="unchanged fixture secret"\n'));assert(e.bytes.toString().startsWith('# retained comment\n'));
 const serialized=JSON.stringify(summary);assert(!serialized.includes(key)&&!serialized.includes('unchanged fixture secret'));assert.equal(summary.releaseAuthorized,false);assert.equal(summary.tenantAuditSettingsChanged,false);
 assert(u.bytes.toString().includes('Environment="PATH=/opt/node22/bin:/opt/node20/bin:/usr/local/bin:/usr/bin:/bin"'));
 assert(!u.bytes.toString().includes('EnvironmentFile='));assert(!u.bytes.toString().includes('User='));assert(!u.bytes.toString().includes('UnsetEnvironment=\n'));
});
test('all duplicate target definitions are removed while quoted unrelated values remain intact',()=>{
 const input=Buffer.from(env.toString()+'DEV_USER_ID="other fixture"\n');const e=proposeCustomerEnvironment(input);assert.equal((e.bytes.toString().match(/AUDIT_HASH_CHAIN_ENABLED=/g)||[]).length,1);assert(e.bytes.toString().includes('PRIVATE_TOKEN="unchanged fixture secret"\n'));
});
test('unsupported CRLF is refused rather than normalized into another configuration',()=>assert.throws(()=>proposeCustomerEnvironment(Buffer.from(env.toString().replaceAll('\n','\r\n'))),/Unsupported CRLF/));

for(const [name,change,reason] of [['target expression',s=>s.replace('DEV_USER_ID=fixture-user','DEV_USER_ID=${PRIVATE_TOKEN}'),/literal environment syntax/],['wrong auth',s=>s.replace('AUTH_PROVIDER=internal','AUTH_PROVIDER=workos'),/internal customer auth/],['demo restored',s=>s.replace('ALLOW_DEMO_SESSION=false','ALLOW_DEMO_SESSION=true'),/internal customer auth/],['env PATH override',s=>s+'PATH=/usr/bin\n',/Private env defines PATH/],['multiline unrelated secret corruption',s=>s+'OTHER_SECRET="line\nDEV_USER_ID=inside-secret\nlast"\n',/literal environment syntax/]])test('refuse '+name,()=>assert.throws(()=>proposeCustomerEnvironment(Buffer.from(change(env.toString()))),reason));
for(const [name,patch] of [['wrong old runtime',{descriptor:descriptor.replaceAll('node20','node24')}],['altered source path',{descriptor:descriptor.replaceAll('/opt/ai-hr/','/tmp/other/')}],['unsafe unit argument',{descriptor:descriptor.replace('3000','3000 $PRIVATE_TOKEN')}],['PATH override not proved',{environmentFilePathOverrideAbsent:undefined}],['relative PATH',{runtimePath:'/usr/bin:.'}],['unknown executable flags',{ordinaryExecStartProved:undefined}]])test('refuse '+name,()=>assert.throws(()=>proposeCustomerUnit({...unitInput,...patch})));
test('changed private proposal bytes cannot be summarized as an approved plan',()=>{const e=proposeCustomerEnvironment(env),u=proposeCustomerUnit(unitInput);e.bytes[0]=65;assert.throws(()=>summarizeCustomerProposal(e,u));});
test('planning refuses shell command substitution instead of evaluating private configuration commands',()=>assert.throws(()=>proposeCustomerEnvironment(Buffer.from(env.toString()+'OTHER_VALUE=$(printf unsafe)\n')),/literal environment syntax/));
test('private Node autoload settings are preserved without executing a Node child',()=>{const input=Buffer.from(env.toString()+"NODE_OPTIONS='--require /nonexistent/private-fixture-hook.cjs'\n");const result=proposeCustomerEnvironment(input);assert(result.bytes.toString().includes("NODE_OPTIONS='--require /nonexistent/private-fixture-hook.cjs'\n"));});
for(const value of ['yes','TRUE'])test('refuse noncanonical demo value '+value,()=>assert.throws(()=>proposeCustomerEnvironment(Buffer.from(env.toString().replace('ALLOW_DEMO_SESSION=false','ALLOW_DEMO_SESSION='+value))),/internal customer auth/));
test('unit proposal refuses a PATH unset and preserves migration credential exclusion',()=>{assert.throws(()=>proposeCustomerUnit({...unitInput,pathUnsetAbsent:false}),/UnsetEnvironment.*PATH/);const u=proposeCustomerUnit(unitInput);assert(u.bytes.toString().includes('UnsetEnvironment=DEV_TENANT_ID DEV_USER_ID MIGRATION_DATABASE_URL\n'));});

test('stdin script preserves a final unterminated assignment and quoted shell metacharacters',()=>{
 const values=parsePrivateEnvironment(Buffer.from("# fixture\nONE='literal $HOME `id` ; $(id)'\nTWO=last"));
 assert.deepEqual(values,{ONE:'literal $HOME `id` ; $(id)',TWO:'last'});
});
test('stdin script separates a final comment from its private result emitter',()=>{
 assert.deepEqual(parsePrivateEnvironment(Buffer.from("ONE=first\n# unterminated comment")),{ONE:'first'});
});

test('preserves the existing systemd PORT substitution as a literal argument',()=>{
 const actual=descriptor.replace('start -p 3000','start -H 127.0.0.1 -p ${PORT}');
 const result=proposeCustomerUnit({...unitInput,descriptor:actual});
 assert(result.bytes.toString().includes('next start -H 127.0.0.1 -p ${PORT}\n'));
 assert.throws(()=>proposeCustomerUnit({...unitInput,descriptor:actual.replace('${PORT}','${PRIVATE_TOKEN}')}),/Unreviewed existing service arguments/);
});
