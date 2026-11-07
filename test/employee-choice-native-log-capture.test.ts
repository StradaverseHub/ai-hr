/** Filesystem/parser/process MODELS only: none supplies native plan provenance. */
import {createHash,randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync,readdirSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {employeeChoiceNativeLogParts,employeeChoiceNativeLogPartBytes,employeeChoiceNativeLogBounds,type NativeLogBinding} from './performance/employee-choice-native-log-parts';
import {employeeChoiceNativeLogRecords,employeeChoiceNativePlanPhases,employeeChoiceNativeMarkerObserver} from './performance/employee-choice-native-log-stream';
import {employeeChoiceNativeLogCollector} from './performance/employee-choice-native-log-collector';
import type {PlanMarker} from './performance/employee-choice-auto-explain-parser';
const directories:string[]=[];
const directory=()=>{const path=mkdtempSync(join(realpathSync(tmpdir()),'aihr-log-model-'));directories.push(path);return path;};
const binding:NativeLogBinding={source:'a'.repeat(40),controller:'b'.repeat(40),run:'123',attempt:'1',pid:77,container:'aihr-ci-model',containerId:'c'.repeat(64),startedAt:'2026-11-08T01:00:00.000Z'};
const query=(edge:string)=>'select 1 as "aihr_ecp_'+('d'.repeat(24))+'_'+edge+'"';
const message=(text:string,pid=77,context='')=>'2026-11-08 00:00:00 UTC ['+pid+'] LOG:  duration: 0.1 ms  plan:\n'+JSON.stringify({'Query Text':text,Plan:{'Node Type':'Result','Actual Rows':1,'Actual Loops':1}},null,2)+'\n'+context;
const marker:PlanMarker={label:'current:model',begin:query('begin'),end:query('end'),native:false};
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});

it('round-trips every byte on both channels with real8MiB boundaries and partial checkpoints',()=>{
 const path=directory(),store=employeeChoiceNativeLogParts(path,binding),raw=Buffer.concat([Buffer.alloc(employeeChoiceNativeLogBounds.partRawBytes-1,65),Buffer.from('人員🙂\n'),Buffer.alloc(256,66)]),noise=Buffer.from('other PID and preamble\n');
 store.append('stderr',noise);store.append('stdout',raw.subarray(0,123));const first=store.checkpoint('first');expect(first.transportClosed).toBe(false);
 store.append('stdout',raw.subarray(123));const final=store.checkpoint('final',true);
 expect(final.rawBytes).toBe(raw.length+noise.length);expect(final.parts).toBe(4);expect(final.gzipBytes).toBeLessThan(final.rawBytes);
 expect(Buffer.concat([...store.read('stdout')].map(part=>part.bytes))).toEqual(raw);expect(Buffer.concat([...store.read('stderr')].map(part=>part.bytes))).toEqual(noise);
 expect(JSON.parse(readFileSync(join(path,'native-log-index.json'),'utf8'))).toMatchObject({binding,semanticQualification:false,releaseAuthorized:false,transportClosed:true});
 expect(()=>store.append('stdout',Buffer.from('late'))).toThrow('admission');
});
it('retains identical real records and cross-part UTF8, escapes, context and outside-phase noise',()=>{
 const raw=Buffer.from('outside preamble\n'+message('unrelated 人員🙂')+message(marker.begin)+message('select "escaped\\quote"')+message('select "escaped\\quote"',77,'CONTEXT: real context 人員\n')+message(marker.end)+message('outside last'));
 const parts=[...raw].map(byte=>({bytes:Buffer.from([byte])}));
 const records=[...employeeChoiceNativeLogRecords(parts)];expect(records).toHaveLength(6);expect(records.map(record=>record.text).join('')).toBe(raw.toString().slice('outside preamble\n'.length));
 const phases=[...employeeChoiceNativePlanPhases(parts,77,[marker],'SELECT forbidden_native_body')];expect(phases).toHaveLength(1);expect(phases[0].entries).toHaveLength(2);expect(phases[0].entries[0].query).toBe(phases[0].entries[1].query);expect(phases[0].entries[1].context).toContain('CONTEXT: real context 人員');
});
it('requires complete marker JSON before acknowledging and does not need a later header',()=>{
 const observed:string[]=[],observer=employeeChoiceNativeMarkerObserver(77,value=>observed.push(value)),raw=Buffer.from(message(marker.end)),closing=raw.lastIndexOf(Buffer.from('}\n'));
 observer.append(raw.subarray(0,closing));expect(observed).toEqual([]);observer.append(raw.subarray(closing));expect(observed).toEqual([marker.end]);observer.finish();
});
it.each(['missing-end','duplicate-begin','outside-body','missing-phase']as const)('refuses %s without pruning a native record',kind=>{
 const body='SELECT exact_native_body',second={...marker,label:'other',begin:query('begin').replace(/d/g,'e'),end:query('end').replace(/d/g,'e')};
 const raw=kind==='missing-end'?message(marker.begin)+message('work'):kind==='duplicate-begin'?message(marker.begin)+message(marker.begin)+message(marker.end):kind==='outside-body'?message(body)+message(marker.begin)+message('work')+message(marker.end):message(marker.begin)+message('work')+message(marker.end);
 expect(()=>[...employeeChoiceNativePlanPhases([{bytes:Buffer.from(raw)}],77,kind==='missing-phase'?[marker,second]:[marker],body)]).toThrow();
});
it.each(['bytes','index','extra-part','removed-part','symlink']as const)('refuses actual retained %s tampering',kind=>{
 const path=directory(),store=employeeChoiceNativeLogParts(path,binding);store.append('stdout',Buffer.from(message(marker.begin)));store.checkpoint('retained');
 const part=readdirSync(path).find(name=>name.startsWith('native-log-part-'))!;
 if(kind==='bytes'){const raw=readFileSync(join(path,part));raw[raw.length-8]^=1;writeFileSync(join(path,part),raw);}
 if(kind==='index')writeFileSync(join(path,'native-log-index.json'),'{}\n');
 if(kind==='extra-part')writeFileSync(join(path,'native-log-part-foreign'),Buffer.from('foreign'));
 if(kind==='removed-part')rmSync(join(path,part));
 if(kind==='symlink'){const target=join(path,'foreign-bytes');writeFileSync(target,readFileSync(join(path,part)),{mode:0o600});rmSync(join(path,part));symlinkSync(target,join(path,part));}
 expect(()=>[...store.read('stdout')]).toThrow();
});
it('refuses foreign bindings, invalidUTF8, rawaggregate excess and failed publication without replacing the old pointer',()=>{
 expect(()=>employeeChoiceNativeLogParts(directory(),{...binding,containerId:'caller-name'})).toThrow('binding');
 expect(()=>[...employeeChoiceNativeLogRecords([{bytes:Buffer.from([0xff])}])]).toThrow();
 const path=directory(),store=employeeChoiceNativeLogParts(path,binding);store.append('stdout',Buffer.from('first\n'));store.checkpoint('first');const before=readFileSync(join(path,'native-log-index.json'));
 writeFileSync(join(path,'native-log-index-2.pending'),'foreign',{mode:0o600});store.append('stdout',Buffer.from('second\n'));expect(()=>store.checkpoint('second')).toThrow();expect(readFileSync(join(path,'native-log-index.json'))).toEqual(before);
 const bounded=employeeChoiceNativeLogParts(directory(),binding),chunk=Buffer.alloc(8*1024*1024,0);for(let i=0;i<16;i++)bounded.append('stdout',chunk);expect(()=>bounded.append('stdout',Buffer.from('overflow'))).toThrow('aggregate');
});

function modelDocker(path:string,stdout:string,stderr=''){
 const executable=join(path,'docker'),counter=join(path,'created');
 const source='#!'+process.execPath+'\n'+
  'const fs=require("node:fs");fs.appendFileSync('+JSON.stringify(counter)+',"1");'+
  'if(process.argv.slice(2).join(" ")!=='+JSON.stringify('logs --follow --since '+binding.startedAt+' '+binding.containerId)+')process.exit(4);'+
  'process.stdout.write('+JSON.stringify(stdout)+');process.stderr.write('+JSON.stringify(stderr)+');'+
  'const interval=setInterval(()=>{},1000);process.on("SIGTERM",()=>{clearInterval(interval);process.stdout.write("",()=>process.exit(0));});\n';
 writeFileSync(executable,source,{mode:0o700});vi.stubEnv('PATH',path);return counter;
}
it('owns one actual model child through begin/end checkpoints, cancellation and settled stream close',{timeout:10000},async()=>{
 const path=directory(),out=directory(),counter=modelDocker(path,message(marker.begin)+message('work')+message(marker.end)),abort=new AbortController(),poison=vi.fn(),collector=employeeChoiceNativeLogCollector(out,binding,abort.signal,poison);
 try{await collector.wait(marker.begin);await collector.wait(marker.end);collector.checkpoint('actual-end');const closing=collector.close();expect(collector.close()).toBe(closing);await closing;
  expect(readFileSync(counter,'utf8')).toBe('1');expect(collector.store.verifyIndex().transportClosed).toBe(true);expect([...employeeChoiceNativePlanPhases(collector.store.read('stdout'),77,[marker],'SELECT forbidden')]).toHaveLength(1);expect(poison).not.toHaveBeenCalled();
 }finally{await collector.close();}
});
it('refuses an already-aborted creation without starting any child',()=>{
 const path=directory(),counter=modelDocker(path,''),abort=new AbortController();abort.abort(Error('deadline'));
 expect(()=>employeeChoiceNativeLogCollector(directory(),binding,abort.signal,vi.fn())).toThrow('deadline');expect(existsSync(counter)).toBe(false);
});
it('drains actual follower after in-flight abort and refuses marker acceptance after close',{timeout:10000},async()=>{
 const path=directory();modelDocker(path,message(marker.begin));const abort=new AbortController(),collector=employeeChoiceNativeLogCollector(directory(),binding,abort.signal,vi.fn());
 try{await collector.wait(marker.begin);const pending=collector.wait(marker.end),reason=Error('owned deadline');abort.abort(reason);await expect(pending).rejects.toThrow('owned deadline');await expect(pending).rejects.toBe(reason);await collector.close();expect(collector.store.verifyIndex().transportClosed).toBe(true);await expect(collector.wait(marker.end)).rejects.toThrow();}
 finally{await collector.close();}
});

it('preserves the fixed20s marker deadline and drains a real model child after refusal',{timeout:10000},async()=>{
 const path=directory();modelDocker(path,message(marker.begin));const abort=new AbortController(),poison=vi.fn(),collector=employeeChoiceNativeLogCollector(directory(),binding,abort.signal,poison);
 try{await collector.wait(marker.begin);vi.useFakeTimers();const pending=collector.wait(marker.end),refused=expect(pending).rejects.toThrow('within20s');await vi.advanceTimersByTimeAsync(20000);await refused;expect(poison).toHaveBeenCalledTimes(1);}
 finally{vi.useRealTimers();await expect(collector.close()).rejects.toThrow('within20s');expect(collector.store.verifyIndex().transportClosed).toBe(true);}
});
it('enforces the128 physical-part cap independently of compression or raw-byte size',()=>{
 const store=employeeChoiceNativeLogParts(directory(),binding);for(let i=0;i<128;i++){store.append('stdout',Buffer.from('x'));store.checkpoint('part'+i);}
 store.append('stdout',Buffer.from('x'));expect(()=>store.checkpoint('part129')).toThrow('part count');
});

it.each(['crc','truncated','concatenated-empty-prefix','trailing']as const)('native decoder refuses %s with honestly recomputed transport hash',kind=>{
 const raw=Buffer.from('real retained raw bytes'),normal=gzipSync(raw,{level:6});
 const gzip=kind==='crc'?Buffer.from(normal):kind==='truncated'?normal.subarray(0,normal.length-1):kind==='concatenated-empty-prefix'?Buffer.concat([gzipSync(Buffer.alloc(0)),normal]):Buffer.concat([normal,Buffer.from('trailing')]);
 if(kind==='crc')gzip[gzip.length-8]^=1;
 const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
 expect(()=>employeeChoiceNativeLogPartBytes(gzip,{rawBytes:raw.length,gzipBytes:gzip.length,rawSha256:sha(raw),gzipSha256:sha(gzip)})).toThrow();
});

it('enforces the reviewed32MiB compressed aggregate without raising the128MiB raw cap',()=>{
 const store=employeeChoiceNativeLogParts(directory(),binding),chunk=randomBytes(employeeChoiceNativeLogBounds.partRawBytes);
 for(let i=0;i<3;i++)store.append('stdout',chunk);expect(()=>store.append('stdout',chunk)).toThrow('compressed part bounds');
});

it('refuses reversed complete raw phase blocks while accepting their exact declared order',()=>{
 const second:PlanMarker={label:'current:second',begin:marker.begin.replace(/d{24}/,'e'.repeat(24)),end:marker.end.replace(/d{24}/,'e'.repeat(24)),native:false};
 const block=(phase:PlanMarker)=>message(phase.begin)+message('select actual_work')+message(phase.end);
 const ordered=[{bytes:Buffer.from(block(marker)+block(second))}],reversed=[{bytes:Buffer.from(block(second)+block(marker))}];
 expect([...employeeChoiceNativePlanPhases(ordered,77,[marker,second],'SELECT forbidden')].map(phase=>phase.label)).toEqual([marker.label,second.label]);
 expect(()=>[...employeeChoiceNativePlanPhases(reversed,77,[marker,second],'SELECT forbidden')]).toThrow('canonical marker order');
});
