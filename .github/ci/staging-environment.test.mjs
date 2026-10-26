/** Real private files and fake read-only systemctl replies; no app, system service or database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fingerprintStagingEnvironment,stagingEnvironmentProbeCommand} from './staging-environment.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'staging-env-')),source=join(root,'source');mkdirSync(source,{mode:0o700});t.after(()=>rmSync(root,{recursive:true,force:true}));
 const unit=join(root,'aihr.service'),external=join(root,'runtime.env');
 writeFileSync(unit,'[Service]\nEnvironmentFile='+external+'\n',{mode:0o600});writeFileSync(external,'PRIVATE_TOKEN=never-export-secret\n',{mode:0o600});
 writeFileSync(join(source,'.env.production'),'MIGRATION_DATABASE_URL=postgres://private-example\n',{mode:0o600});
 const values={Environment:'PATH=/opt/node20/bin:/usr/bin NODE_ENV=production',EnvironmentFiles:external+' (ignore_errors=no)',PassEnvironment:'',UnsetEnvironment:'MIGRATION_DATABASE_URL',
  PAMName:'',RootDirectory:'',RootImage:'',DynamicUser:'no',User:'aihr',Group:'',WorkingDirectory:source,ExecStart:'{ path=/opt/node20/bin/node ; argv[]=/opt/node20/bin/node '+source+'/node_modules/next/dist/bin/next start -p 3000 ; pid=1 ; }',
  FragmentPath:unit,DropInPaths:'',LoadCredential:'',LoadCredentialEncrypted:'',SetCredential:'',SetCredentialEncrypted:'',ImportCredential:''};
 let manager='PATH=/usr/bin\nSERVER_TOKEN=never-export-secret\n',pid=1;
 const systemctl=args=>args[0]==='show-environment'?manager:Object.entries({...values,ExecStart:values.ExecStart.replace('pid=1','pid='+pid++)}).map(([k,v])=>k+'='+v).join('\n')+'\n';
 return {root,source,unit,external,values,systemctl,setManager:value=>manager=value,fingerprint:()=>fingerprintStagingEnvironment(source,{systemctl})};
}
test('stable configuration and changing execution-only PID fields produce one digest without exposing values',t=>{
 const f=fixture(t),a=f.fingerprint();assert.match(a,/^[a-f0-9]{64}$/);assert.equal(f.fingerprint(),a);assert(!a.includes('never-export-secret'));
 const command=stagingEnvironmentProbeCommand();assert(command.includes(fingerprintStagingEnvironment.toString()));assert(command.includes("<<'AIHR_STAGING_ENV_NODE'"));assert(!command.includes('never-export-secret'));
});
test('each optional Next dotenv presence/content and required production dotenv changes are fingerprinted',t=>{
 const f=fixture(t);
 for(const name of ['.env.production.local','.env.local','.env']){
  const before=f.fingerprint(),path=join(f.source,name);writeFileSync(path,'PRIVATE_VALUE=one\n',{mode:0o600});assert.notEqual(f.fingerprint(),before);
  const first=f.fingerprint();writeFileSync(path,'PRIVATE_VALUE=two\n');assert.notEqual(f.fingerprint(),first);rmSync(path);assert.equal(f.fingerprint(),before);
 }
 const before=f.fingerprint();writeFileSync(join(f.source,'.env.production'),'MIGRATION_DATABASE_URL=postgres://changed-private-example\n');assert.notEqual(f.fingerprint(),before);
});
test('external EnvironmentFiles, unit/drop-in bytes and manager/configured environment remain bound',t=>{
 const f=fixture(t);
 for(const path of [f.external,f.unit]){
  const bytes=readFileSync(path),before=f.fingerprint();writeFileSync(path,Buffer.concat([bytes,Buffer.from('\n# changed\n')]));assert.notEqual(f.fingerprint(),before);writeFileSync(path,bytes);
 }
 const before=f.fingerprint();f.setManager('PATH=/usr/bin\nSERVER_TOKEN=changed-but-never-exported\n');assert.notEqual(f.fingerprint(),before);
 const configured=f.fingerprint();f.values.Environment+=' PRIVATE_OTHER=different';assert.notEqual(f.fingerprint(),configured);
 const drop=join(f.root,'override.conf');writeFileSync(drop,'[Service]\nNice=1\n');f.values.DropInPaths=drop;const dropDigest=f.fingerprint();writeFileSync(drop,'[Service]\nNice=2\n');assert.notEqual(f.fingerprint(),dropDigest);
});
test('unsupported glob/PAM/credential/root/dynamic-principal sources refuse without secret values',t=>{
 const f=fixture(t);
 for(const key of ['PAMName','RootDirectory','RootImage','LoadCredential','LoadCredentialEncrypted','SetCredential','SetCredentialEncrypted','ImportCredential']){
  f.values[key]='never-export-secret';assert.throws(f.fingerprint,e=>!e.message.includes('never-export-secret'));f.values[key]='';
 }
 f.values.DynamicUser='yes';assert.throws(f.fingerprint);f.values.DynamicUser='no';
 f.values.EnvironmentFiles=f.external+'* (ignore_errors=no)';assert.throws(f.fingerprint);
});
test('compile keys in any dotenv/configured/manager source refuse and never echo their value',t=>{
 const f=fixture(t);
 for(const name of ['.env.production.local','.env.local','.env']){
  const path=join(f.source,name);writeFileSync(path,'NEXT_PUBLIC_FIXTURE=never-export-secret\n');assert.throws(f.fingerprint,e=>!e.message.includes('never-export-secret'));rmSync(path);
 }
 const bytes=readFileSync(f.external);writeFileSync(f.external,'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=never-export-secret\n');assert.throws(f.fingerprint);writeFileSync(f.external,bytes);
 f.values.Environment+=' "NEXT_PUBLIC_FIXTURE=never-export-secret"';assert.throws(f.fingerprint);f.values.Environment='NODE_ENV=production';
 f.setManager('NEXT_PUBLIC_FIXTURE=never-export-secret\n');assert.throws(f.fingerprint,e=>!e.message.includes('never-export-secret'));
});
test('optional missing systemd environment file is explicit; symlinked or required missing files refuse',t=>{
 const f=fixture(t),missing=join(f.root,'absent.env');f.values.EnvironmentFiles=missing+' (ignore_errors=yes)';const absent=f.fingerprint();
 writeFileSync(missing,'SERVER_VALUE=one');assert.notEqual(f.fingerprint(),absent);rmSync(missing);symlinkSync(f.external,missing);assert.throws(f.fingerprint);rmSync(missing);
 f.values.EnvironmentFiles=missing+' (ignore_errors=no)';assert.throws(f.fingerprint);
});
test('configuration or file changes during the two reads refuse instead of producing mixed authority',t=>{
 const f=fixture(t);let calls=0;
 const changing=args=>{const value=f.systemctl(args);if(args[0]==='show-environment'&&++calls===1)writeFileSync(f.external,'SERVER_VALUE=concurrent-change\n');return value;};
 assert.throws(()=>fingerprintStagingEnvironment(f.source,{systemctl:changing}),/changed during fingerprint/);
});
