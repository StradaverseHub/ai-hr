'use strict';
/** Fixed nonroot closure probe; never application handlers, SQL, providers or root JS. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {brotliDecompressSync}=require('node:zlib');
const STAGES=Object.freeze(['admission','next-version','sharp-image','font-layout','next-config','executable-maps']);
function failure(stage){
 if(!STAGES.includes(stage))throw Error('Unknown native dependency probe stage');
 return JSON.stringify({version:1,kind:'NATIVE_DEPENDENCY_PROBE_REFUSAL',stage})+'\n';
}
function progress(stage){
 if(!STAGES.includes(stage))throw Error('Unknown native dependency probe stage');
 return JSON.stringify({version:1,kind:'NATIVE_DEPENDENCY_PROBE_STAGE_ENTERED',stage})+'\n';
}
function admit(facts=process,filesystem=fs){
 assert.equal(facts.platform,'linux');assert(facts.getuid()>0);
 assert.equal(facts.argv.length,3);assert.equal(facts.env.NODE_ENV,'production');
 assert.equal(facts.env.NEXT_TELEMETRY_DISABLED,'1');assert.equal(facts.env.HOME,'/var/empty/aihr');
 assert(!Object.keys(facts.env).some(key=>/TOKEN|SECRET|PASSWORD|DATABASE|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_PATH|API_KEY/.test(key)));
 const root=facts.argv[2];assert(path.isAbsolute(root)&&filesystem.realpathSync(root)===root);
 assert.equal(facts.cwd(),root,'Native dependency probe must start inside the copied runtime');
 return root;
}
async function main(){
 let stage='admission';
 try{
 process.stderr.write(progress(stage));
 const root=admit();
 const requirePackage=createRequire(path.join(root,'package.json'));
 const ownedRequire=id=>{
  const resolved=fs.realpathSync(requirePackage.resolve(id));
  assert(resolved.startsWith(root+'/node_modules/'),'Native probe dependency escaped copied namespace');
  return requirePackage(id);
 };
 stage='next-version';process.stderr.write(progress(stage));
 const next=ownedRequire('next/package.json');assert.equal(next.version,'16.4.1');
 stage='sharp-image';process.stderr.write(progress(stage));
 const sharp=ownedRequire('sharp');
 const image=await sharp({create:{width:2,height:2,channels:4,background:{r:12,g:34,b:56,alpha:1}}}).png().toBuffer();
 assert(image.length>20&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
 stage='font-layout';process.stderr.write(progress(stage));
 const fontkit=ownedRequire('fontkit');
 const font=brotliDecompressSync(fs.readFileSync(path.join(root,'assets/fonts/NotoSansSC-Regular.otf.br')));
 const layout=fontkit.create(font).layout('测试');assert.equal(layout.glyphs.length,2);assert(layout.glyphs.every(glyph=>glyph.id>0));
 // Load the actual production config through Next's own reader. This primes the
 // stock TS/SWC/config dependency closure as the nonroot app principal; it does
 // not create a server, render a handler, or submit an application command.
 stage='next-config';process.stderr.write(progress(stage));
 const config=await ownedRequire('next/dist/server/config').default('phase-production-server',root);
 assert(Array.isArray(config.serverExternalPackages)&&config.serverExternalPackages.includes('fontkit'));
 stage='executable-maps';process.stderr.write(progress(stage));
 const executableFiles=new Set();
 for(const line of fs.readFileSync('/proc/self/maps','utf8').trim().split('\n')){
  const match=/^\S+\s+(\S+)\s+\S+\s+[0-9a-f]+:[0-9a-f]+\s+\d+(?:\s+(.*))?$/.exec(line);assert(match);
  if(!match[1].includes('x')||!match[2]||!match[2].startsWith('/'))continue;
  assert(!match[2].endsWith(' (deleted)'));
  const file=fs.realpathSync(match[2]);
  assert(file===fs.realpathSync(process.execPath)||file.startsWith(root+'/')||file.startsWith('/usr/lib/'));
  executableFiles.add(file);
 }
 assert(executableFiles.has(fs.realpathSync(process.execPath)));
 assert.equal(process.cwd(),root);assert.equal(process.env.HOME,'/var/empty/aihr');
 process.stdout.write(JSON.stringify({version:1,kind:'NONROOT_NATIVE_DEPENDENCY_PROBE_NOT_APPLICATION_ACCEPTANCE',
  runtime:{node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next:next.version},
  uid:process.getuid(),imageBytes:image.length,cjkGlyphs:layout.glyphs.length,copiedRuntimeCwdVerified:true,privateHomeVerified:true,
  executableFiles:[...executableFiles].sort()})+'\n');
 }catch{process.stderr.write(failure(stage));process.exitCode=1;}
}
module.exports=Object.freeze({STAGES,failure,progress,admit});
if(require.main===module)void main();
