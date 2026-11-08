/** Runtime-boundary controls only; never native query, speed or release proof. */
import {expect,it} from 'vitest';
import {exactAsciiForbiddenEnvironment,exactAsciiHeapOnly,exactAsciiKernel,exactAsciiLaunchShape,exactAsciiFileIdentityEqual,exactAsciiBinaryMatch,exactAsciiIntrinsicIdentity} from './performance/employee-choice-exact-ascii-runtime-contract';
import {asciiProofRuntime,asciiProofVersion} from './fixtures/employee-choice-ascii-observation';
import * as actual from './performance/employee-choice-exact-ascii-runtime';
const preload='/reviewed/node_modules/vitest/suppress-warnings.cjs';
it('retains the exact authenticated binary/scalar contract without exposing mutable configuration',()=>{
 expect(exactAsciiKernel).toMatchObject({bytes:124827920,sha256:'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48',scalarSha256:'ff6936b6d5ff8edf886c317df3428816a2b70781dfb101498beda8dad1fa6acb',preloadBytes:862});expect(Object.isFrozen(exactAsciiKernel)).toBe(true);
});
it('recognizes only the closed actual Vitest launch grammar and returns a source verification obligation',()=>{
 const value=exactAsciiLaunchShape(['--experimental-import-meta-resolve','--require',preload,'--conditions=node','--conditions=development']);expect(value).toEqual({preload});expect(Object.isFrozen(value)).toBe(true);
 expect(exactAsciiLaunchShape(['--experimental-import-meta-resolve','-r',preload,'--max-old-space-size=6144'])).toEqual({preload});
 // A matching filename is still NOT eligibility. Actual startup independently
 // resolves and hashes the exact dependency before any process qualification.
 expect(exactAsciiLaunchShape(['--experimental-import-meta-resolve','--require','/unreviewed/suppress-warnings.cjs'])).toEqual({preload:'/unreviewed/suppress-warnings.cjs'});
});
it('recognizes the exact observed seven-token worker shape without granting runtime qualification',()=>{
 const argv=Object.freeze(['--experimental-import-meta-resolve','--require',preload,'--conditions','node','--conditions','development']);
 const before=[...argv],parsed=exactAsciiLaunchShape(argv);expect(parsed).toEqual({preload});expect(Object.isFrozen(parsed)).toBe(true);expect(argv).toEqual(before);
 expect(Object.keys(parsed!)).toEqual(['preload']);
});
it('refuses missing foreign malformed NUL and truncated separate condition values',()=>{
 const prefix=['--experimental-import-meta-resolve','--require',preload];
 for(const suffix of [['--conditions'],['--conditions',''],['--conditions','production'],['--conditions','Node'],['--conditions','node,development'],['--conditions','node\0'],['--conditions','development\n'],['--conditions','/foreign/value'],['--conditions','--require'],['--conditions','node','--conditions'],['--conditions','node','foreign'],['--conditions=production']])expect(exactAsciiLaunchShape([...prefix,...suffix])).toBeNull();
});
it('retains duplicate and mixed-form handling of already allowed conditions while refusing duplicate launch owners',()=>{
 const prefix=['--experimental-import-meta-resolve','--require',preload];
 for(const suffix of [['--conditions=node','--conditions=node'],['--conditions','node','--conditions=node'],['--conditions=development','--conditions','node','--conditions','development'],['--conditions','node','--max-old-space-size=4096','--conditions','node']])expect(exactAsciiLaunchShape([...prefix,...suffix])).toEqual({preload});
 for(const suffix of [['--conditions','node','--require',preload],['--conditions','development','--experimental-import-meta-resolve'],['--conditions','node','--import','foreign']])expect(exactAsciiLaunchShape([...prefix,...suffix])).toBeNull();
});
it('refuses every reviewed ICU/loader flag form instead of accepting a filename or boolean claim',()=>{
 for(const flags of [['--icu-data-dir=/tmp/data'],['--icu-data-dir','/tmp/data'],['--import','tsx'],['--import=data:text/javascript,'],['--loader','loader.js'],['--experimental-loader=loader.js'],['--eligible=true'],['--require','data:text/javascript,']])expect(exactAsciiLaunchShape([...flags,'--experimental-import-meta-resolve','--require',preload])).toBeNull();
});
it('refuses absent duplicated truncated relative and NUL-bearing launch owners',()=>{
 for(const flags of [[],['--require',preload],['--experimental-import-meta-resolve'],['--experimental-import-meta-resolve','--require'],['--experimental-import-meta-resolve','--require','relative.cjs'],['--experimental-import-meta-resolve','--require','/nul\0file'],['--experimental-import-meta-resolve','--experimental-import-meta-resolve','--require',preload],['--experimental-import-meta-resolve','--require',preload,'--require',preload]])expect(exactAsciiLaunchShape(flags)).toBeNull();
});
it('does not turn arbitrary inherited NODE_OPTIONS into a reviewed startup profile',()=>{
 for(const value of ['', '--max-old-space-size=4096','--max-old-space-size=6144'])expect(exactAsciiHeapOnly(value)).toBe(true);
 for(const value of ['--max-old-space-size=16384','--require evil','--import=tsx','--icu-data-dir=/tmp','--max-old-space-size=4096 --require=evil',' --max-old-space-size=4096','--max-old-space-size=4096\0'])expect(exactAsciiHeapOnly(value)).toBe(false);
});
it('covers both Node ICU and native dynamic-loader environment capabilities explicitly',()=>{
 for(const key of ['NODE_ICU_DATA','ICU_DATA','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','DYLD_INSERT_LIBRARIES','DYLD_LIBRARY_PATH','DYLD_FRAMEWORK_PATH'])expect(exactAsciiForbiddenEnvironment).toContain(key);expect(Object.isFrozen(exactAsciiForbiddenEnvironment)).toBe(true);
});
it('a forged caller profile cannot activate the actual input-free owner or create a reusable eligibility token',()=>{
 const forged=Object.freeze({eligible:true,status:'qualified',versions:{node:'22.23.3',icu:'78.3',unicode:'17.0',v8:'12.4.254.21-node.57'},sha256:exactAsciiKernel.sha256});
 expect(Reflect.apply(actual.exactAsciiPrototypeRuntime,undefined,[forged])).toBe(false);
 expect(actual.exactAsciiPrototypeRuntimeEvidence()).toMatchObject({status:'fallback',releaseAuthorized:false});
 expect(actual.exactAsciiPrototypeRuntime(new AbortController().signal)).toBe(false);
 expect(Object.keys(actual).sort()).toEqual(['closeExactAsciiPrototypeRuntime','exactAsciiPrototypeRuntime','exactAsciiPrototypeRuntimeEvidence'].sort());
});
it('explicit owner shutdown is idempotent and cannot be reversed by copied evidence',()=>{
 const copied={...actual.exactAsciiPrototypeRuntimeEvidence(),status:'qualified'};actual.closeExactAsciiPrototypeRuntime();actual.closeExactAsciiPrototypeRuntime();expect(copied.status).toBe('qualified');expect(actual.exactAsciiPrototypeRuntime()).toBe(false);expect(actual.exactAsciiPrototypeRuntimeEvidence()).toMatchObject({status:'closed',reason:'owner-closed',releaseAuthorized:false});
});
it('refuses changed actual binary bytes/digest and every unsupported runtime version in the predicates used by the owner',()=>{
 expect(exactAsciiBinaryMatch(exactAsciiKernel.bytes,exactAsciiKernel.sha256)).toBe(true);
 for(const [bytes,sha]of [[exactAsciiKernel.bytes-1,exactAsciiKernel.sha256],[exactAsciiKernel.bytes+1,exactAsciiKernel.sha256],[exactAsciiKernel.bytes,'0'.repeat(64)],[exactAsciiKernel.bytes,exactAsciiKernel.sha256.toUpperCase()]]as const)expect(exactAsciiBinaryMatch(bytes,sha)).toBe(false);
 expect(asciiProofRuntime(asciiProofVersion)).toBe(true);for(const key of Object.keys(asciiProofVersion))expect(asciiProofRuntime({...asciiProofVersion,[key]:'unknown'})).toBe(false);
});
it('retains every FD/source identity field and refuses replacement same-size and timestamp-only drift',()=>{
 const before={device:BigInt(1),inode:BigInt(2),bytes:BigInt(3),mtime:BigInt(4),ctime:BigInt(5)};expect(exactAsciiFileIdentityEqual(before,{...before})).toBe(true);
 for(const key of ['device','inode','bytes','mtime','ctime']as const)expect(exactAsciiFileIdentityEqual(before,{...before,[key]:before[key]+BigInt(1)})).toBe(false);
});
it('compares actual intrinsic references without trusting matching function text or a copied source claim',()=>{
 const lower=()=>'',trim=()=>'',includes=()=>false,fromCodePoint=()=>'',before={lower,trim,includes,fromCodePoint};expect(exactAsciiIntrinsicIdentity(before,{...before})).toBe(true);
 for(const key of ['lower','trim','includes','fromCodePoint']as const)expect(exactAsciiIntrinsicIdentity(before,{...before,[key]:()=>''})).toBe(false);
});
