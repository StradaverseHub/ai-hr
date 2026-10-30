/** Authenticated CI build packet integrity. No unpacking, deployment or test reuse authority. */
import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,readSync,lstatSync,readFileSync,readdirSync,realpathSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {assertSuccessfulObservation,STAGING_BUILD_RUNTIME,BUILD_CAPACITY_PROFILE,assertBuildCapacityProfile,assertBuildPacketAggregate} from './build-production.mjs';
export const BUILD_ARTIFACT='production-build-v1';
export const BUILD_ARCHIVE_MAX=BUILD_CAPACITY_PROFILE.archiveMaxBytes;
export const BUILD_ZIP_MAX=BUILD_CAPACITY_PROFILE.zipMaxBytes;
const fail=message=>{throw Error('CI build packet refused: '+message);};
const requireValue=(value,message)=>{if(!value)fail(message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function file(path,bound,content=true){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd);
  requireValue(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=bound,'nonregular or oversized packet member');
  const data=content?readFileSync(fd):null,h=createHash('sha256');
  if(content)h.update(data);else{
   const chunk=Buffer.allocUnsafe(1024**2);let position=0,count;
   while((count=readSync(fd,chunk,0,chunk.length,position))>0){position+=count;requireValue(position<=bound,'growing packet member');h.update(chunk.subarray(0,count));}
   requireValue(position===before.size,'packet length changed');
  }
  const after=fstatSync(fd),current=lstatSync(path);
  for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])requireValue(before[key]===after[key]&&before[key]===current[key],'packet changed while reading');
  requireValue(!current.isSymbolicLink(),'packet member became a symlink');
  return {data,sha256:h.digest('hex'),bytes:before.size};
 }finally{closeSync(fd);}
}
/** Expected identity comes from independently authenticated run/job metadata.
 * Full archive member/package/compiled-value checks remain mandatory at installation.
 */
export function inspectCiBuildPacket(directory,expected){
 directory=resolve(directory);
 requireValue(realpathSync(directory)===directory&&!lstatSync(directory).isSymbolicLink(),'packet path differs');
 requireValue(isDeepStrictEqual(readdirSync(directory).sort(),['build-provenance.json','bytes','successful-build.json','system-testing.json']),'packet inventory differs');
 const bytesDirectory=join(directory,'bytes');
 requireValue(lstatSync(bytesDirectory).isDirectory()&&!lstatSync(bytesDirectory).isSymbolicLink()
  &&isDeepStrictEqual(readdirSync(bytesDirectory).sort(),['build-bundle-files.json','build-bundle.tar.gz']),'binary packet inventory differs');
 const evidence={};
 for(const [name,bound]of [['build-provenance.json',1024**2],['system-testing.json',80*1024],['successful-build.json',1024**2],['bytes/build-bundle-files.json',16*1024**2]])
  evidence[name]=file(join(directory,name),bound);
 const p=JSON.parse(evidence['build-provenance.json'].data),preparedBytes=evidence['system-testing.json'].data;
 const prepared=JSON.parse(preparedBytes),observation=JSON.parse(evidence['successful-build.json'].data),manifest=JSON.parse(evidence['bytes/build-bundle-files.json'].data);
 requireValue(/^[a-f0-9]{40}$/.test(expected.candidate??'')&&/^[a-f0-9]{40}$/.test(expected.controller??'')
  &&Number.isSafeInteger(expected.runId)&&expected.runId>0&&['main','alpha'].includes(expected.controllerBranch),'independent expected identity');
 assertBuildCapacityProfile(p?.capacityProfile);assertBuildCapacityProfile(manifest?.capacityProfile);
 requireValue(p?.format===2&&p.kind==='ci-system-testing-build-candidate'&&p.releaseAuthorized===false
  &&p.source===expected.candidate&&p.controller===expected.controller&&p.runId===expected.runId&&p.runAttempt===1
  &&p.repository==='StradaverseHub/ai-hr'&&p.repositoryId===1333414856
  &&p.workflowRef==='StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/'+expected.controllerBranch
  &&isDeepStrictEqual(p.runtime,STAGING_BUILD_RUNTIME)&&UUID.test(p.buildRecordId??'')
  &&typeof p.nextBuildId==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(p.nextBuildId)
  &&typeof p.buildSourcePath==='string'&&p.buildSourcePath.startsWith('/')&&p.buildSourcePath.length<=4096
  &&!p.buildSourcePath.split('/').some(part=>part==='.'||part==='..')&&!/[\x00-\x1f\x7f]/.test(p.buildSourcePath),'canonical build provenance');
 for(const key of ['lockSha256','packageSha256','preparedSha256','successfulObservationSha256','manifestSha256','archiveSha256'])requireValue(SHA.test(p[key]??''),'provenance digest');
 for(const [name,key]of [['system-testing.json','preparedSha256'],['successful-build.json','successfulObservationSha256'],['bytes/build-bundle-files.json','manifestSha256']])
  requireValue(evidence[name].sha256===p[key],'bound record bytes differ');
 requireValue(prepared?.format===1&&prepared.activeServiceVerified===false&&prepared.identity?.sourceRef===p.source
  &&prepared.identity.buildRecordId===p.buildRecordId,'prepared source/build identity');
 const started=Date.parse(expected.producerStartedAt),completed=Date.parse(expected.producerCompletedAt);
 requireValue(Number.isFinite(started)&&Number.isFinite(completed)&&completed>=started,'producing job times');
 assertSuccessfulObservation(observation,prepared,preparedBytes,p.nextBuildId,started,completed);
 requireValue(manifest?.format===2&&manifest.kind==='next-build-byte-bundle'&&manifest.platform==='linux'&&manifest.nextBuildId===p.nextBuildId
  &&manifest.archiveBytes===p.archiveBytes&&manifest.archiveSha256===p.archiveSha256,'bundle identity');
 const archive=file(join(directory,'bytes/build-bundle.tar.gz'),BUILD_ARCHIVE_MAX,false);
 assertBuildPacketAggregate([...Object.values(evidence).map(member=>member.bytes),archive.bytes]);
 requireValue(archive.bytes===p.archiveBytes&&archive.sha256===p.archiveSha256,'bundle archive bytes differ');
 return {format:2,capacityProfile:BUILD_CAPACITY_PROFILE,kind:'AUTHENTICATED_CI_BUILD_PACKET_NOT_DEPLOYMENT',source:p.source,controller:p.controller,runId:p.runId,
  nextBuildId:p.nextBuildId,buildRecordId:p.buildRecordId,buildSourcePath:p.buildSourcePath,runtime:p.runtime,
  provenanceSha256:evidence['build-provenance.json'].sha256,archiveSha256:p.archiveSha256,archiveBytes:p.archiveBytes,
  manifestSha256:p.manifestSha256,preparedSha256:p.preparedSha256,successfulObservationSha256:p.successfulObservationSha256,
  lockSha256:p.lockSha256,packageSha256:p.packageSha256,packetDirectory:directory,
  releaseAuthorized:false,archiveMembersVerified:false,activeServiceVerified:false};
}
/** The release caller must independently regenerate the canonical source preparation. */
export function bindCiBuildSource(packet,{lockBytes,packageBytes,preparedBytes}){
 requireValue(Buffer.isBuffer(lockBytes)&&Buffer.isBuffer(packageBytes)&&Buffer.isBuffer(preparedBytes),'canonical candidate inputs missing');
 requireValue(packet.lockSha256===hash(lockBytes)&&packet.packageSha256===hash(packageBytes)&&packet.preparedSha256===hash(preparedBytes),'candidate dependencies or canonical preparation differ');
 return {...packet,canonicalCandidateInputsVerified:true};
}
