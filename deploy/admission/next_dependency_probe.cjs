'use strict';
/** Fixed nonroot closure probe; never application handlers, SQL, providers or root JS. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {brotliDecompressSync}=require('node:zlib');
assert.equal(process.platform,'linux');assert(process.getuid()>0);
assert.equal(process.argv.length,3);assert.equal(process.env.NODE_ENV,'production');
assert.equal(process.env.NEXT_TELEMETRY_DISABLED,'1');
assert(!Object.keys(process.env).some(key=>/TOKEN|SECRET|PASSWORD|DATABASE|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_PATH|API_KEY/.test(key)));
const root=process.argv[2];assert(path.isAbsolute(root)&&fs.realpathSync(root)===root);
const requirePackage=createRequire(path.join(root,'package.json'));
(async()=>{
 const next=requirePackage('next/package.json');assert.equal(next.version,'16.4.1');
 const sharp=requirePackage('sharp');
 const image=await sharp({create:{width:2,height:2,channels:4,background:{r:12,g:34,b:56,alpha:1}}}).png().toBuffer();
 assert(image.length>20&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
 const fontkit=requirePackage('fontkit');
 const font=brotliDecompressSync(fs.readFileSync(path.join(root,'assets/fonts/NotoSansSC-Regular.otf.br')));
 const layout=fontkit.create(font).layout('测试');assert.equal(layout.glyphs.length,2);assert(layout.glyphs.every(glyph=>glyph.id>0));
 // Load the actual production config through Next's own reader. This primes the
 // stock TS/SWC/config dependency closure as the nonroot app principal; it does
 // not create a server, render a handler, or submit an application command.
 const config=await requirePackage('next/dist/server/config').default('phase-production-server',root);
 assert(Array.isArray(config.serverExternalPackages)&&config.serverExternalPackages.includes('fontkit'));
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
 process.stdout.write(JSON.stringify({version:1,kind:'NONROOT_NATIVE_DEPENDENCY_PROBE_NOT_APPLICATION_ACCEPTANCE',
  runtime:{node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next:next.version},
  imageBytes:image.length,cjkGlyphs:layout.glyphs.length,executableFiles:[...executableFiles].sort()})+'\n');
})().catch(()=>{process.stderr.write('Native dependency probe refused\n');process.exitCode=1;});
