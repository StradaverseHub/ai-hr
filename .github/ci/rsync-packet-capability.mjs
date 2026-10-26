/** Probe the actual local packet flags before remote reads, archive downloads or staging writes. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export const PACKET_MODE_ARGS=Object.freeze(['-a','--chmod=D700,F600']);
export function assertRsyncPacketCapability({file='rsync',run=(bin,args)=>execFileSync(bin,args,{encoding:'utf8',timeout:10000,maxBuffer:65536})}={}){
 const began=Date.now(),directory=mkdtempSync(join(tmpdir(),'aihr-rsync-packet-probe-'));
 const source=join(directory,'source'),target=join(directory,'target'),payload=Buffer.from('AIHR packet permission capability\n');
 try{
  mkdirSync(source);mkdirSync(join(source,'nested'));chmodSync(source,0o755);chmodSync(join(source,'nested'),0o755);
  writeFileSync(join(source,'nested','packet'),payload);chmodSync(join(source,'nested','packet'),0o644);
  try{run(file,[...PACKET_MODE_ARGS,'--',source+'/',target+'/']);}
  catch(error){throw new Error('Local rsync cannot execute the required private packet flags. Select a compatible rsync (GNU rsync on macOS) before deployment; staging has not been touched.',{cause:error});}
  for(const path of [target,join(target,'nested')]){const st=lstatSync(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o777)===0o700,'Packet directory mode probe differs');}
  const path=join(target,'nested','packet'),st=lstatSync(path);
  assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.mode&0o777)===0o600,'Packet file mode probe differs');
  assert(readFileSync(path).equals(payload),'Packet bytes changed during local mode probe');
  return {kind:'LOCAL_RSYNC_PACKET_PERMISSION_PROBE_NOT_DEPLOYMENT',flags:[...PACKET_MODE_ARGS],directoryMode:'0700',fileMode:'0600',payloadBytesVerified:true,elapsedMs:Date.now()-began,releaseAuthorized:false};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
