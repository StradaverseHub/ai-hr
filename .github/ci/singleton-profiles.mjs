/** Trusted full-CI provisioning, fixed commands only; never a focused flag broker. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,realpathSync,lstatSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {singletonSources,assertSingletonUnit,validateSingletonHost,validateSingletonBinding} from './singleton-protocol.mjs';
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
export function actualSingletonHost(plan,unit,dir,env=process.env){
 const workspace=realpathSync(env.GITHUB_WORKSPACE),temp=realpathSync(env.RUNNER_TEMP),source=realpathSync(join(workspace,'source')),automation=realpathSync(join(workspace,'automation'));
 const layout={workspace,temp,source,automation,cwd:realpathSync(process.cwd()),evidence:realpathSync(dir),platform:process.platform,
  sourceHead:git(source,'rev-parse','HEAD'),controllerHead:git(automation,'rev-parse','HEAD'),sourceClean:git(source,'status','--porcelain')==='',controllerClean:git(automation,'status','--porcelain')===''};
 assert.equal(source,resolve(workspace,'source'));assert.equal(automation,resolve(workspace,'automation'));assert.equal(dir,resolve(temp,'aihr-ci'));
 const eventPath=realpathSync(env.GITHUB_EVENT_PATH);assert(lstatSync(eventPath).isFile());assert(lstatSync(eventPath).size<=1048576);
 validateSingletonHost({env,event:JSON.parse(readFileSync(eventPath,'utf8')),layout,plan,unit});return layout;
}
export function provisionSingletonHost(plan,unit,dir){
 actualSingletonHost(plan,unit,dir);const descriptor=assertSingletonUnit(unit);assert.equal(descriptor.profile,'linux-systemd-nginx-v1');
 const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:120000,maxBuffer:1048576});
 run('sudo',['-n','apt-get','update','-qq']);run('sudo',['-n','apt-get','install','-y','--no-install-recommends','nginx']);
 // nginx -v prints to stderr; capture it without shell interpolation.
 const version=spawnSync('/usr/sbin/nginx',['-v'],{encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(version.status,0);
 return {kind:'actual-job-systemd-nginx',platform:process.platform,pid1:readFileSync('/proc/1/comm','utf8').trim(),sudoUid:run('sudo',['-n','id','-u']).trim(),
  nginxPath:realpathSync('/usr/sbin/nginx'),nginxSha256:createHash('sha256').update(readFileSync('/usr/sbin/nginx')).digest('hex'),nginxVersion:version.stderr.trim(),systemdVersion:run('systemctl',['--version']).split('\n')[0]};
}
export function writeSingletonBinding(plan,unit,dir,prerequisites){
 actualSingletonHost(plan,unit,dir);
 const binding={schemaVersion:1,mode:'full-ci-singleton',candidate:plan.sha,controller:plan.controller,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
  unit:unit.id,fingerprint:plan.fingerprint,file:unit.files[0],profile:unit.singleton.profile,sourceHashes:plan.singletonSources[unit.id],evidenceDirectory:dir,prerequisites};
 for(const file of singletonSources(unit)){const path=join(process.cwd(),file);assert.equal(realpathSync(path),path);assert(lstatSync(path).isFile());assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),binding.sourceHashes[file]);}
 validateSingletonBinding(binding,plan,unit,{runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT});
 const path=join(dir,`${unit.id}-singleton.json`),bytes=JSON.stringify(binding,null,2)+'\n';writeFileSync(path,bytes,{flag:'wx',mode:0o600});return {binding,path,bytes};
}
