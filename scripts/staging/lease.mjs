/** Lease is scheduling authority only. Existing release evidence checks remain authoritative. */
import {readFileSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {isAbsolute,resolve} from 'node:path';
export const COORDINATOR='/var/tmp/aihr-deploy/staging-release-queue/coordinator.py';
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
export function readLease(candidate,environment=process.env){
 const path=environment.AIHR_STAGING_LEASE_FILE;
 if(!path||!isAbsolute(path)||realpathSync(path)!==path)throw Error('Set AIHR_STAGING_LEASE_FILE to the private canonical lease credential');
 const st=lstatSync(path);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.size>4096)throw Error('Owned0600 lease credential required');
 const g=JSON.parse(readFileSync(path,'utf8'));
 if(g.protocol!=='aihr-staging-queue/v1'||g.candidate!==candidate||!Number.isSafeInteger(g.epoch)||g.epoch<1||! /^[a-f0-9]{64}$/.test(g.token)||! /^[a-f0-9-]{36}$/.test(g.batch)||g.releaseAuthorized!==false)throw Error('Lease candidate/protocol/credential differs');
 return g;
}
export function leaseEnvironment(g){return {AIHR_STAGING_BATCH:g.batch,AIHR_STAGING_EPOCH:String(g.epoch),AIHR_STAGING_TOKEN:g.token,AIHR_STAGING_CANDIDATE:g.candidate};}
export function leasePrefix(g){return 'env '+Object.entries(leaseEnvironment(g)).map(([k,v])=>k+'='+quote(v)).join(' ');}
export function guardCommand(g,command){return leasePrefix(g)+' python3 '+COORDINATOR+' guard -- bash -c '+quote(command);}
export function guardedRsync(g,args){return ['--rsync-path='+leasePrefix(g)+' python3 '+COORDINATOR+' guard -- rsync',...args];}
export function leasePhase(g,ssh,phase,build){
 return JSON.parse(ssh('python3 '+COORDINATOR,{input:JSON.stringify({protocol:g.protocol,action:'phase',actor:'ci-operator',batch:g.batch,epoch:g.epoch,token:g.token,candidate:g.candidate,phase,...(build?{build}: {})})}));
}
/** Direct server CLIs re-exec under a kernel operation lock if coordination has been commissioned. */
export function guardServerCli(candidate){
 if(resolve(process.cwd())!=='/opt/ai-hr'||!existsSync(COORDINATOR))return;
 if(process.env.AIHR_STAGING_CANDIDATE!==candidate)throw Error('Server operation source differs from staging lease');
 if(process.env.AIHR_STAGING_NODE_GUARDED!=='1'){
  const r=spawnSync('python3',[COORDINATOR,'guard','--',process.execPath,...process.execArgv,...process.argv.slice(1)],{stdio:'inherit',env:{...process.env,AIHR_STAGING_NODE_GUARDED:'1'}});
  if(r.error)throw r.error;process.exit(r.status??1);
 }
 execFileSync('python3',[COORDINATOR,'assert-env'],{stdio:['ignore','ignore','inherit']});
}
