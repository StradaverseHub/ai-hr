/** Actual frozen source filter + real local rsync protocol through a private fake SSH endpoint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {stagingTransport} from './staging-transport.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const raw=await import(pathToFileURL(join(root,'scripts/improve/release.ts')).href),official={...(raw.default??{}),...raw};
test('actual canonical rsync uses private config/alias and protects source/recipient operator data',()=>{
 const temp=realpathSync(mkdtempSync(join(tmpdir(),'staging transfer '))),source=join(temp,'source'),target=join(temp,'target'),bin=join(temp,'bin');
 try{
  for(const path of [source,target,bin])mkdirSync(path,{mode:0o700});
  for(const path of [join(source,'.improve'),join(target,'.improve'),join(target,'.next'),join(target,'node_modules')])mkdirSync(path,{mode:0o700});
  writeFileSync(join(source,'.improve/ssh_config'),'Host aihr-staging\n  HostName staging.invalid\n',{mode:0o600});
  writeFileSync(join(source,'.improve/private-operator-key'),'synthetic source private bytes');
  writeFileSync(join(source,'visible.txt'),'authorized fixture source');
  writeFileSync(join(target,'.improve/retained'),'synthetic retained operator bytes');
  writeFileSync(join(target,'.next/BUILD_ID'),'retained-build');
  writeFileSync(join(target,'node_modules/retained'),'retained-dependencies');
  const trace=join(temp,'ssh-args.json');
  const code='#!'+process.execPath+'\n'+
   'const fs=require("node:fs"),cp=require("node:child_process");const args=process.argv.slice(2);'+
   'fs.writeFileSync('+JSON.stringify(trace)+',JSON.stringify(args));const index=args.indexOf("rsync");if(index<0||!args.includes("aihr-staging"))process.exit(97);'+
   'const server=args.slice(index+1);if(!server.includes("--server")||server.at(-1)!=="/opt/ai-hr/")process.exit(98);server[server.length-1]='+JSON.stringify(target+'/')+';'+
   'const result=cp.spawnSync("/usr/bin/rsync",server,{stdio:"inherit"});process.exit(result.status??99);';
  writeFileSync(join(bin,'ssh'),code,{mode:0o700});
  const transport=stagingTransport(source,{}),args=transport.rsyncArgs(official,source);
  const result=spawnSync('/usr/bin/rsync',args,{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(readFileSync(join(target,'visible.txt'),'utf8'),'authorized fixture source');
  assert.equal(readFileSync(join(target,'.improve/retained'),'utf8'),'synthetic retained operator bytes');
  assert(!existsSync(join(target,'.improve/ssh_config')));assert(!existsSync(join(target,'.improve/private-operator-key')));
  assert.equal(readFileSync(join(target,'.next/BUILD_ID'),'utf8'),'retained-build');
  assert.equal(readFileSync(join(target,'node_modules/retained'),'utf8'),'retained-dependencies');
  const used=JSON.parse(readFileSync(trace));assert(used.includes(join(source,'.improve/ssh_config')));assert(used.includes('StrictHostKeyChecking=yes'));assert(!used.slice(0,used.indexOf('rsync')).includes('-p'));
 }finally{rmSync(temp,{recursive:true,force:true});}
});
