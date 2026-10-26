/** Exercise the actual workflow launcher against one tiny typed import, with native stripping disabled. No application code runs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('actual build-cache workflow launcher supports Node20-style typed dynamic imports; original invocation fails',()=>{
 const workflow=readFileSync(join(root,'.github/workflows/alpha-staging-diagnostics.yml'),'utf8');
 const marker='      - name: Genuine canonical build, full application compiler and retained-graph refusal controls\n';const offset=workflow.indexOf(marker);assert(offset>=0);
 const match=workflow.slice(offset+marker.length).match(/^        run: ([^\r\n]+)\n/);assert(match&&match[1].length>10);
 const original=JSON.parse(readFileSync(join(root,'.github/ci/fixtures/next-build-launcher-original.json')));
 assert(original.runId===40250429043&&original.source==='b5a75d5ac09b3f2b01841609874a4e83eb405d54');
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'next-typed-launch-'))),target=join(dir,'entry.mjs');
 try{
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  writeFileSync(join(dir,'value.ts'),'export const answer: number = 42;\n');
  writeFileSync(target,'const raw=await import("./value.ts");if(raw.answer!==42)throw Error("wrong import");console.log("REAL_TYPED_IMPORT_OK");\n');
  const invoke=line=>{const args=line.trim().split(/\s+/);assert(args.at(-1)==='../automation/.github/ci/next-build-cache.mjs');args[args.length-1]=target;
   const env={...process.env,NODE_OPTIONS:process.allowedNodeEnvironmentFlags.has('--no-experimental-strip-types')?'--no-experimental-strip-types':''};
   return spawnSync(args[0],args.slice(1),{cwd:process.env.AIHR_LAUNCHER_TEST_SOURCE||process.cwd(),env,encoding:'utf8',timeout:15000});};
  const before=invoke(original.command);assert.notEqual(before.status,0);assert((before.stdout+before.stderr).includes('ERR_UNKNOWN_FILE_EXTENSION'));
  const after=invoke(match[1]);assert.equal(after.status,0,after.stdout+after.stderr);assert(after.stdout.includes('REAL_TYPED_IMPORT_OK'));
 }finally{rmSync(dir,{recursive:true});}
});
