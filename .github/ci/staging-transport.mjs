/** Private staging alias and strict source-pending transport. No release/gate authority. */
import {existsSync,lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {PACKET_MODE_ARGS} from './rsync-packet-capability.mjs';
export const STAGING=Object.freeze({host:'aihr-staging',port:'',user:'',directory:'/opt/ai-hr',stateDirectory:'/var/tmp/aihr-deploy'});
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
export function bindStaging(env){
 const values={IMPROVE_SSH_HOST:STAGING.host,IMPROVE_SSH_PORT:STAGING.port,IMPROVE_SSH_USER:STAGING.user,IMPROVE_REMOTE_DIR:STAGING.directory,AIHR_DEPLOY_STATE_DIR:STAGING.stateDirectory};
 for(const [key,value]of Object.entries(values)){if(env[key]!==undefined&&env[key]!==value)throw Error('Staging target mismatch: '+key);env[key]=value;}
 return values;
}
export function stagingTransport(candidatePath,environment=process.env){
 bindStaging(environment);candidatePath=resolve(candidatePath);
 const local=join(candidatePath,'.improve/ssh_config'),explicit=environment.AIHR_SSH_CONFIG;
 const selected=explicit??(existsSync(local)?local:null);
 const args=[];
 if(selected){
  if(!isAbsolute(selected)||realpathSync(selected)!==selected)throw Error('Private SSH config must be a canonical absolute path');
  const st=lstatSync(selected);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o777)!==0o600)throw Error('Private SSH config must be owned regular0600');
  args.push('-F',selected);
 }
 args.push('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12');
 const remote=STAGING.host+':'+STAGING.directory+'/';
 return {sshArgs:command=>[...args,STAGING.host,command],configSelected:selected!==null,
  packetRsyncArgs:(packet,destination)=>{
   if(!isAbsolute(packet)||realpathSync(packet)!==packet||!lstatSync(packet).isDirectory()||lstatSync(packet).isSymbolicLink())throw Error('Canonical private verified packet required');
   if(typeof destination!=='string'||!/^\/[A-Za-z0-9_./-]+\/\.aihr-ci-builds\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/packet$/.test(destination)||destination.split('/').some(p=>p==='.'||p==='..'))throw Error('Private installation packet destination differs');
   return [...PACKET_MODE_ARGS,'-e',['ssh',...args].map(quote).join(' '),'--',packet+'/',STAGING.host+':'+destination+'/'];
  },
  rsyncArgs:(official,source)=>{
   // Reuse the actual candidate filter, changing only its transport and fixed destination.
   const result=official.deploymentRsyncArgs(source,remote);
   const indices=result.flatMap((value,index)=>value==='-e'?[index]:[]);
   if(indices.length!==1||result.at(-1)!==remote||result.at(-2)!==source.replace(/\/?$/,'/'))throw Error('Canonical source transport shape differs');
   if(!result.some((value,index)=>value==='--exclude'&&result[index+1]==='/.improve/'))throw Error('Canonical filter must protect private operator configuration');
   result[indices[0]+1]=['ssh',...args].map(quote).join(' ');
   return result;
  }};
}
/** Verify the authoritative pending marker; the legacy helper's zero exit alone is insufficient.
 * The coordinating release owner must still hold the exclusive staging window.
 * @param {string} ref
 * @param {string} dir
 * @param {string} stateDir
 */
export function strictPendingCommand(ref,dir=STAGING.directory,stateDir=STAGING.stateDirectory){
 if(!sha(ref)||!isAbsolute(dir)||!isAbsolute(stateDir)||dir.includes('\0')||stateDir.includes('\0'))throw Error('Invalid staging pending identity');
 const pending=join(stateDir,'pending');
 return [
  'set -eu',
  'cd '+quote(dir),
  'test -x deploy/deploy-state.sh',
  'test -d '+quote(stateDir),
  'test ! -L '+quote(stateDir),
  'test ! -e '+quote(pending),
  'test ! -L '+quote(pending),
  'AIHR_DEPLOY_STATE_DIR='+quote(stateDir)+' deploy/deploy-state.sh pending '+quote(ref),
  'test -f '+quote(pending),
  'test ! -L '+quote(pending),
  'test "$(sed -n '+quote('s/^ref=//p')+' '+quote(pending)+')" = '+quote(ref),
 ].join('\n');
}
