/** Lossless owned native log bytes only. No native-plan or release authority. */
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,writeSync,fsyncSync,fstatSync,lstatSync,readFileSync,realpathSync,renameSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync,gunzipSync,inflateRawSync} from 'node:zlib';
const MiB=1024*1024;
export const employeeChoiceNativeLogBounds=Object.freeze({partRawBytes:8*MiB,rawAggregateBytes:128*MiB,gzipAggregateBytes:32*MiB,indexBytes:2*MiB,parts:128,recordBytes:64*MiB,phaseBytes:64*MiB,memberBytes:64*MiB,checkpointMs:20000});
export type NativeLogChannel='stdout'|'stderr';
export type NativeLogBinding={source:string;controller:string;run:string;attempt:string;pid:number;container:string;containerId:string;startedAt:string};
export type NativeLogPart={channel:NativeLogChannel;sequence:number;start:number;rawBytes:number;gzipBytes:number;rawSha256:string;gzipSha256:string;file:string};
export type NativeLogIndex={kind:'ACTUAL_LOSSLESS_NATIVE_LOG_PARTS_NOT_RELEASE';version:1;binding:NativeLogBinding;checkpoint:string;transportClosed:boolean;semanticQualification:false;releaseAuthorized:false;rawBytes:number;gzipBytes:number;channels:Record<NativeLogChannel,{bytes:number;sha256:string}>;parts:NativeLogPart[]};
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const channels:readonly NativeLogChannel[]=['stdout','stderr'];
/** Pure bounded decoding only; source/index ownership is established by caller. */
export function employeeChoiceNativeLogPartBytes(gzip:Buffer,part:Pick<NativeLogPart,'rawBytes'|'gzipBytes'|'rawSha256'|'gzipSha256'>){
 if(!Number.isSafeInteger(part.rawBytes)||part.rawBytes<1||part.rawBytes>employeeChoiceNativeLogBounds.partRawBytes||gzip.length>employeeChoiceNativeLogBounds.memberBytes
  ||gzip.length!==part.gzipBytes||sha(gzip)!==part.gzipSha256||gzip.length<18||gzip[0]!==31||gzip[1]!==139||gzip[2]!==8||gzip[3]!==0||gzip.readUInt32LE(gzip.length-4)!==part.rawBytes)throw Error('Exact single native gzip member required');
 // A native raw-deflate decoder reports the exact consumed stream length. This
 // rejects trailing/concatenated members even if a final empty member or equal
 // ISIZE could otherwise mask their presence. gunzip separately validates CRC.
 const stream:unknown=inflateRawSync(gzip.subarray(10,gzip.length-8),{info:true,maxOutputLength:employeeChoiceNativeLogBounds.partRawBytes});
 if(!stream||typeof stream!=='object'||!('engine'in stream)||!stream.engine||typeof stream.engine!=='object'||!('bytesWritten'in stream.engine)
  ||stream.engine.bytesWritten!==gzip.length-18||!('buffer'in stream)||!Buffer.isBuffer(stream.buffer))throw Error('Trailing or concatenated native gzip member');
 const raw=gunzipSync(gzip,{maxOutputLength:employeeChoiceNativeLogBounds.partRawBytes});
 if(raw.length!==part.rawBytes||sha(raw)!==part.rawSha256||!raw.equals(stream.buffer))throw Error('Native raw part bytes differ');return raw;
}
export function employeeChoiceNativeLogParts(directory:string,binding:NativeLogBinding){
 const original=lstatSync(directory);
 if(!original.isDirectory()||original.isSymbolicLink()||original.uid!==process.getuid!()||(original.mode&0o777)!==0o700||realpathSync(directory)!==directory)throw Error('Owned private native log directory required');
 if(!/^[a-f0-9]{40}$/.test(binding.source)||!/^[a-f0-9]{40}$/.test(binding.controller)||!/^\d{1,16}$/.test(binding.run)||binding.attempt!=='1'
  ||!Number.isSafeInteger(binding.pid)||binding.pid<1||!/^aihr-ci-[A-Za-z0-9-]+$/.test(binding.container)||!/^[a-f0-9]{64}$/.test(binding.containerId)||!Number.isFinite(Date.parse(binding.startedAt)))throw Error('Exact native log source and observed process binding required');
 const bound={...binding},parts:NativeLogPart[]=[],state={stdout:{chunks:[]as Buffer[],pending:0,bytes:0,stored:0,hash:createHash('sha256')},stderr:{chunks:[]as Buffer[],pending:0,bytes:0,stored:0,hash:createHash('sha256')}};
 let rawBytes=0,gzipBytes=0,generation=0,closed=false,indexBytes:Buffer|undefined,indexSha256:string|undefined,published:NativeLogIndex|undefined;
 const pointer=join(directory,'native-log-index.json');
 const owner=()=>{const now=lstatSync(directory);if(!now.isDirectory()||now.isSymbolicLink()||now.uid!==original.uid||now.dev!==original.dev||now.ino!==original.ino||(now.mode&0o777)!==0o700||realpathSync(directory)!==directory)throw Error('Native log directory identity changed');};
 const sameFile=(a:ReturnType<typeof fstatSync>,b:ReturnType<typeof fstatSync>)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mode===b.mode&&a.uid===b.uid&&a.gid===b.gid&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
 function readOwned(name:string,maximum:number){
  owner();const path=join(directory,name),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.uid!==original.uid||(before.mode&0o777)!==0o600||before.size>maximum)throw Error('Bounded owned native log file required');
   const raw=readFileSync(fd);if(!sameFile(before,fstatSync(fd))||!sameFile(before,lstatSync(path)))throw Error('Native log file identity changed');owner();return raw;
  }finally{closeSync(fd);}
 }
 function writeOwned(name:string,payload:Buffer){
  owner();const path=join(directory,name),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{let offset=0;while(offset<payload.length){const n=writeSync(fd,payload,offset,payload.length-offset);if(n<=0)throw Error('Native log write made no progress');offset+=n;}fsyncSync(fd);
   const info=fstatSync(fd);if(!info.isFile()||info.uid!==original.uid||info.nlink!==1||info.size!==payload.length||(info.mode&0o777)!==0o600||!sameFile(info,lstatSync(path)))throw Error('Native log written file changed');owner();
  }finally{closeSync(fd);}
 }
 function flush(channel:NativeLogChannel){
  const current=state[channel];if(!current.pending)return;
  if(parts.length>=employeeChoiceNativeLogBounds.parts)throw Error('Native log part count exceeded');
  const raw=Buffer.concat(current.chunks,current.pending),gzip=gzipSync(raw,{level:6});
  if(raw.length>employeeChoiceNativeLogBounds.partRawBytes||gzip.length>employeeChoiceNativeLogBounds.memberBytes||gzipBytes+gzip.length>employeeChoiceNativeLogBounds.gzipAggregateBytes)throw Error('Native log compressed part bounds exceeded');
  const part:NativeLogPart={channel,sequence:parts.length+1,start:current.stored,rawBytes:raw.length,gzipBytes:gzip.length,rawSha256:sha(raw),gzipSha256:sha(gzip),file:'native-log-part-'+(parts.length+1)+'.'+channel+'.log.gz'};
  writeOwned(part.file,gzip);parts.push(part);gzipBytes+=gzip.length;current.stored+=raw.length;current.chunks=[];current.pending=0;
 }
 function append(channel:NativeLogChannel,value:Buffer){
  if(closed||!channels.includes(channel)||!Buffer.isBuffer(value))throw Error('Native log stream admission refused');
  if(rawBytes+value.length>employeeChoiceNativeLogBounds.rawAggregateBytes)throw Error('Native raw aggregate bound exceeded');
  const current=state[channel];current.hash.update(value);current.bytes+=value.length;rawBytes+=value.length;
  let offset=0;while(offset<value.length){const size=Math.min(value.length-offset,employeeChoiceNativeLogBounds.partRawBytes-current.pending);current.chunks.push(Buffer.from(value.subarray(offset,offset+size)));current.pending+=size;offset+=size;if(current.pending===employeeChoiceNativeLogBounds.partRawBytes)flush(channel);}
 }
 function checkpoint(label:string,transportClosed=false){
  if(closed||typeof label!=='string'||label.length>160||label.includes('\0'))throw Error('Native log checkpoint refused');
  for(const channel of channels)flush(channel);
  if(indexBytes){if(sha(readOwned('native-log-index.json',employeeChoiceNativeLogBounds.indexBytes))!==indexSha256)throw Error('Native log index changed');}
  else if(existsSync(pointer))throw Error('Foreign native log index exists');
  const index:NativeLogIndex={kind:'ACTUAL_LOSSLESS_NATIVE_LOG_PARTS_NOT_RELEASE',version:1,binding:{...bound},checkpoint:label,transportClosed,semanticQualification:false,releaseAuthorized:false,rawBytes,gzipBytes,
   channels:{stdout:{bytes:state.stdout.bytes,sha256:state.stdout.hash.copy().digest('hex')},stderr:{bytes:state.stderr.bytes,sha256:state.stderr.hash.copy().digest('hex')}},parts:parts.map(part=>({...part}))};
  const raw=Buffer.from(JSON.stringify(index,null,2)+'\n');if(raw.length>employeeChoiceNativeLogBounds.indexBytes)throw Error('Native log index byte bound exceeded');
  const temporary='native-log-index-'+(++generation)+'.pending';writeOwned(temporary,raw);renameSync(join(directory,temporary),pointer);
  const descriptor=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(descriptor);}finally{closeSync(descriptor);}
  indexBytes=raw;indexSha256=sha(raw);published=index;closed=transportClosed;return{file:'native-log-index.json',sha256:indexSha256,rawBytes,gzipBytes,parts:parts.length,transportClosed};
 }
 function verifyIndex(){
  if(!indexBytes||!indexSha256||!published)throw Error('No actual native log index retained');
  // A durable pointer describes ONLY its published snapshot. Newly buffered or
  // written parts cannot inherit an earlier checkpoint hash after publication
  // failure, even when every new byte is owned by this same collector.
  if(rawBytes!==published.rawBytes||gzipBytes!==published.gzipBytes||closed!==published.transportClosed||JSON.stringify(parts)!==JSON.stringify(published.parts)
   ||channels.some(channel=>state[channel].pending!==0||state[channel].stored!==published!.channels[channel].bytes||state[channel].bytes!==published!.channels[channel].bytes
    ||state[channel].hash.copy().digest('hex')!==published!.channels[channel].sha256))throw Error('Native log has unpublished bytes or parts');
  const actual=readOwned('native-log-index.json',employeeChoiceNativeLogBounds.indexBytes);if(!actual.equals(indexBytes)||sha(actual)!==indexSha256)throw Error('Native log index differs from its source owner');
  const expected=new Set(published.parts.map(part=>part.file));for(const name of readdirSync(directory))if(name.startsWith('native-log-part-')&&!expected.has(name))throw Error('Unindexed native log part present');
  return{file:'native-log-index.json',sha256:indexSha256,rawBytes:published.rawBytes,gzipBytes:published.gzipBytes,parts:published.parts.length,transportClosed:published.transportClosed};
 }
 function* read(channel:NativeLogChannel){
  verifyIndex();if(!channels.includes(channel))throw Error('Native log channel refused');let offset=0;const hash=createHash('sha256');
  for(const part of published!.parts.filter(part=>part.channel===channel)){
   if(part.start!==offset||part.sequence<1||part.rawBytes<1||part.rawBytes>employeeChoiceNativeLogBounds.partRawBytes)throw Error('Native part sequence/range differs');
   const gzip=readOwned(part.file,employeeChoiceNativeLogBounds.memberBytes);
   const raw=employeeChoiceNativeLogPartBytes(gzip,part);offset+=raw.length;hash.update(raw);yield{start:part.start,bytes:raw};
  }
  if(offset!==state[channel].stored||offset!==state[channel].bytes||hash.digest('hex')!==state[channel].hash.copy().digest('hex'))throw Error('Complete native channel coverage differs');verifyIndex();
 }
 return{append,checkpoint,verifyIndex,read,snapshot:()=>({current:{rawBytes,gzipBytes,parts:parts.length,transportClosed:closed,pendingBytes:state.stdout.pending+state.stderr.pending},published:published&&indexSha256?{sha256:indexSha256,rawBytes:published.rawBytes,gzipBytes:published.gzipBytes,parts:published.parts.length,transportClosed:published.transportClosed}:null})};
}
