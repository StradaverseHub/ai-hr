import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {deploymentRsyncArgs} from '../scripts/improve/release';

it('the actual deployment filter ships app changes while keeping internal records local and existing server records intact',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-r385-release-'));
 const source=join(root,'source'),destination=join(root,'server');
 try{
  for(const dir of [source,destination])mkdirSync(join(dir,'docs','adr'),{recursive:true});
  writeFileSync(join(source,'app.txt'),'synthetic new app source');
  writeFileSync(join(destination,'obsolete-app.txt'),'obsolete synthetic app source');
  writeFileSync(join(source,'docs','HANDOFF-HISTORY.md'),'synthetic local internal history');
  writeFileSync(join(source,'docs','adr','0091-private.md'),'synthetic local internal decision');
  writeFileSync(join(destination,'docs','HANDOFF-HISTORY.md'),'synthetic existing server history');
  writeFileSync(join(destination,'docs','adr','0090-existing.md'),'synthetic existing server decision');
  execFileSync('rsync',deploymentRsyncArgs(source,destination+'/'));
  expect(readFileSync(join(destination,'app.txt'),'utf8')).toBe('synthetic new app source');
  expect(existsSync(join(destination,'obsolete-app.txt'))).toBe(false);
  expect(readFileSync(join(destination,'docs','HANDOFF-HISTORY.md'),'utf8')).toBe('synthetic existing server history');
  expect(existsSync(join(destination,'docs','adr','0091-private.md'))).toBe(false);
  expect(readFileSync(join(destination,'docs','adr','0090-existing.md'),'utf8')).toBe('synthetic existing server decision');
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('the actual backend deployment keeps native artifacts and signing inputs local while shipping mobile source',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-mobile-deploy-'));
 const source=join(root,'source'),destination=join(root,'server');
 const privateInputs=['android/app/build/intermediates/signing_config/release/config.json','ios/Pods/fixture.txt','dist/bundle.hbc','builds/test.apk','.expo/settings.json','credentials.json','signing.p8','signing.key','signing.pem','signing.p12','signing.jks','signing.keystore','signing.mobileprovision'];
 try{
  mkdirSync(destination,{recursive:true});
  for(const name of [...privateInputs,'app/sign-in.tsx']){
   const path=join(source,'mobile',name);mkdirSync(dirname(path),{recursive:true});
   writeFileSync(path,name==='app/sign-in.tsx'?'synthetic mobile source':'synthetic private build input');
  }
  execFileSync('rsync',deploymentRsyncArgs(source,destination+'/'));
  expect(readFileSync(join(destination,'mobile','app','sign-in.tsx'),'utf8')).toBe('synthetic mobile source');
  for(const name of privateInputs)expect(existsSync(join(destination,'mobile',name)),name).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('the actual deployment excludes only root scratchpad while protecting existing server scratch files from deletion',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-scratchpad-deploy-'));
 const source=join(root,'source'),destination=join(root,'server');
 const put=(base:string,name:string,value:string)=>{const path=join(base,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,value);};
 try{
  put(source,'app/page.tsx','synthetic updated app source');
  put(destination,'app/page.tsx','synthetic previous app source');
  put(destination,'app/obsolete.tsx','synthetic removed app source');
  put(source,'scratchpad/acceptance/database.sql','synthetic private local database dump');
  put(source,'scratchpad/auth/tls.key','synthetic private local TLS key');
  put(source,'scratchpad/shared.txt','synthetic local scratch replacement');
  put(destination,'scratchpad/shared.txt','synthetic existing server scratch');
  put(destination,'scratchpad/server-only.txt','synthetic server-only scratch');
  put(source,'app/scratchpad/example.txt','synthetic nested app source');
  put(destination,'app/scratchpad/obsolete.txt','synthetic obsolete nested app source');
  // Both endpoints are temporary local paths: the production argv invokes no SSH here.
  execFileSync('rsync',deploymentRsyncArgs(source,destination+'/'));
  expect(existsSync(join(destination,'scratchpad','acceptance','database.sql'))).toBe(false);
  expect(existsSync(join(destination,'scratchpad','auth','tls.key'))).toBe(false);
  expect(readFileSync(join(destination,'scratchpad','shared.txt'),'utf8')).toBe('synthetic existing server scratch');
  expect(readFileSync(join(destination,'scratchpad','server-only.txt'),'utf8')).toBe('synthetic server-only scratch');
  expect(readFileSync(join(destination,'app','page.tsx'),'utf8')).toBe('synthetic updated app source');
  expect(existsSync(join(destination,'app','obsolete.tsx'))).toBe(false);
  expect(readFileSync(join(destination,'app','scratchpad','example.txt'),'utf8')).toBe('synthetic nested app source');
  expect(existsSync(join(destination,'app','scratchpad','obsolete.txt'))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
