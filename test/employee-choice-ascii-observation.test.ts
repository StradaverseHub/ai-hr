/** Pure proof controls only; production lookup and native API remain unchanged. */
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {expect,it} from 'vitest';
import {asciiObservation,asciiProofInputs,asciiProofQuery,asciiProofRuntime,asciiProofVersion,compareScalarCorpus,deriveAsciiCaseContract,nodeScalarCorpus,readAsciiCaseContract,sigmaContextVectors,validateScalarCorpus} from './fixtures/employee-choice-ascii-observation';
import {asciiProofLifetime} from './fixtures/employee-choice-ascii-proof-lifetime';
const versions=asciiProofVersion;
it('derives the complete reviewed exception/context partition from both pinned primary files',()=>{
 const contract=readAsciiCaseContract();expect(contract.exceptions).toEqual([{cp:0x130,lower:[0x69,0x307]},{cp:0x212a,lower:[0x6b]}]);
 expect(contract.emptyDefaultMappings).toBe(0);expect(contract.conditionalRows).toHaveLength(16);expect(contract.localeInsensitiveConditional).toBe('Final_Sigma');
});
it('refuses unknown fields/contexts, duplicate/reordered rows and hidden range mappings instead of assuming future data compatibility',()=>{
 const unicode=readFileSync(asciiProofInputs.unicode.file,'utf8'),special=readFileSync(asciiProofInputs.special.file,'utf8');
 const range='3400;<CJK Ideograph Extension A, First>;Lo;0;L;;;;;N;;;;;',changedRange=range.split(';');changedRange[13]='0069';expect(unicode).toContain(range);expect(special).toContain('03A3; 03C2;');
 for(const altered of [special.replace('Final_Sigma;','Unknown_Context;'),special+'\n0130; 0069; 0130; 0130;\n',special.replace('03A3; 03C2;','03A3; ;')])expect(()=>deriveAsciiCaseContract(unicode,altered)).toThrow();
 for(const altered of [unicode+'\n'+unicode.split('\n').find(line=>line.startsWith('0041;'))+'\n',unicode.split('\n').reverse().join('\n'),unicode.replace(range,changedRange.join(';'))])expect(()=>deriveAsciiCaseContract(altered,special)).toThrow();
});
it('retains Unicode barriers and literal ASCII substring meaning without folding, normalization or locale casing',()=>{
 for(const value of ['AİB','AKB','AÉB','AΣB','İA','KA','ßſﬀ','😀A\u0307B'])expect(asciiObservation(value.toLowerCase())).toBe(asciiObservation(value.replaceAll('İ','i\u0307').replace(/[A-ZK]/g,char=>char==='K'?'k':String.fromCharCode(char.charCodeAt(0)+32))));
 expect('İA'.toLowerCase().includes('ia')).toBe(false);expect('İA'.toLowerCase().includes('i')).toBe(true);expect('KA'.toLowerCase().includes('ka')).toBe(true);
 expect(asciiObservation('i\u0307a')).not.toBe(asciiObservation('ia'));expect(asciiObservation('ßſﬀ')).not.toContain('ss');
 const vectors=sigmaContextVectors();expect(vectors).toHaveLength(81);
 for(const vector of vectors)expect(vector.text.toLowerCase().includes('ς')).toBe(vector.final);
 expect('ΟΣ'.toLowerCase()).toBe('ος');expect('ΟΣΑ'.toLowerCase()).toBe('οσα');
});
it('compares all ordered native-shaped records and refuses changed bytes, gaps, duplicates, order and incomplete counts',context=>{
 const deadline=performance.now()+30000,active=()=>{context.signal.throwIfAborted();if(performance.now()>=deadline)throw Error('Original 30-second proof limit exceeded');};
 const corpus=nodeScalarCorpus(readAsciiCaseContract(),active);expect(validateScalarCorpus(corpus.bytes).count).toBe(1112063);expect(compareScalarCorpus(corpus.bytes,Buffer.from(corpus.bytes))).toMatchObject({count:1112063,sha256:corpus.sha256});
 const changed=Buffer.from(corpus.bytes);changed[8]=2;expect(()=>compareScalarCorpus(changed,corpus.bytes)).toThrow('differs');
 const duplicate=Buffer.from(corpus.bytes);duplicate.writeUInt32BE(1,9);expect(()=>compareScalarCorpus(duplicate,corpus.bytes)).toThrow('Missing/repeated/reordered');
 const reordered=Buffer.from(corpus.bytes);reordered.writeUInt32BE(2,0);expect(()=>compareScalarCorpus(reordered,corpus.bytes)).toThrow('Missing/repeated/reordered');
 expect(()=>compareScalarCorpus(corpus.bytes.subarray(9),corpus.bytes)).toThrow('Missing/repeated/reordered');expect(()=>compareScalarCorpus(corpus.bytes.subarray(0,corpus.bytes.length-11),corpus.bytes)).toThrow();
 const invalid=Buffer.from(corpus.bytes);invalid[8]=0;expect(()=>compareScalarCorpus(invalid,corpus.bytes)).toThrow('Noncanonical');
 active();
});
function latch(){let release:()=>void=()=>{throw Error('Uninitialized deferred control');};const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
it('refuses an already-aborted case before any native construction can begin',async()=>{
 const owner=asciiProofLifetime(),controller=new AbortController(),hooks:Array<()=>Promise<void>>=[];let starts=0;controller.abort(Error('owned abort'));
 await expect(owner.run({signal:controller.signal,onTestFinished:hook=>hooks.push(hook)},async()=>{starts++;})).rejects.toThrow('successor refused');
 await Promise.all(hooks.map(hook=>hook()));expect(starts).toBe(0);expect(()=>owner.beforeCase()).toThrow('successor refused');
});
it('owns timed-out body and deferred cleanup until both drain, then permanently refuses successor work',async()=>{
 const owner=asciiProofLifetime(),controller=new AbortController(),hooks:Array<()=>Promise<void>>=[],started=latch(),body=latch(),cleanup=latch(),cleaning=latch();
 const operation=owner.run({signal:controller.signal,onTestFinished:hook=>hooks.push(hook)},async()=>{started.release();await body.promise;try{controller.signal.throwIfAborted();}finally{cleaning.release();await cleanup.promise;}});
 const refusal=expect(operation).rejects.toThrow('owned abort');await started.promise;controller.abort(Error('owned abort'));let drained=false;const finish=Promise.all(hooks.map(hook=>hook())).then(()=>{drained=true;});
 body.release();await cleaning.promise;expect(drained).toBe(false);expect(()=>owner.beforeCase()).toThrow('successor refused');cleanup.release();await refusal;await finish;expect(drained).toBe(true);expect(()=>owner.beforeCase()).toThrow('successor refused');
});
it('retains compound body/cleanup failure and blocks later work after uncertain close',async()=>{
 const owner=asciiProofLifetime(),controller=new AbortController(),hooks:Array<()=>Promise<void>>=[],body=Error('body failure'),cleanup=Error('close uncertain');
 const operation=owner.run({signal:controller.signal,onTestFinished:hook=>hooks.push(hook)},async()=>{owner.poison(cleanup);throw new AggregateError([body,cleanup],'body and cleanup failed');});
 await expect(operation).rejects.toMatchObject({errors:[body,cleanup]});await Promise.all(hooks.map(hook=>hook()));expect(()=>owner.beforeCase()).toThrow('successor refused');
});
it('models exact prepared-query eligibility and the retained JavaScript fallback for unsupported profiles and non-ASCII queries',()=>{
 expect(asciiProofRuntime(versions)).toBe(true);
 for(const [key,value]of [['node','22.23.4'],['icu','77.1'],['unicode','16.0'],['v8','']]){const unsupported={...versions,[key]:value};expect(asciiProofRuntime(unsupported)).toBe(false);expect(asciiProofQuery('ASCII',unsupported).mode).toBe('javascript-fallback');}
 for(const raw of ['%','_','\\',' A B ','\u007f','\u0001','K']){const result=asciiProofQuery(raw,versions);expect(result.mode).toBe('native-ascii-proof');expect(result.q).toBe(raw.trim().toLowerCase());expect(result.raw).toBe(raw);}
 expect(asciiProofQuery(' \t\n',versions).mode).toBe('none');expect(asciiProofQuery('x\0y',versions).mode).toBe('impossible');
 for(const raw of ['İ','i\u0307','😀','\ud800'])expect(asciiProofQuery(raw,versions).mode).toBe('javascript-fallback');
});
