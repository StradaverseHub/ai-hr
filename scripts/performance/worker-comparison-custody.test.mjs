import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {comparisonClock,holdWorkerComparisonFiles,readComparisonJson} from './worker-comparison-custody.mjs';

test('sealed admission is bounded, exclusive-owner, digest-matched and no-follow',()=>{
 const temp=mkdtempSync(join(tmpdir(),'worker-admission-'));
 try{
  const admission=join(temp,'receipt'),raw='{"source":"fictional"}\n';
  writeFileSync(admission,raw,{mode:0o600});
  const hash=createHash('sha256').update(raw).digest('hex');
  assert.deepEqual(readComparisonJson(admission,128,hash),{source:'fictional'});
  assert.throws(()=>readComparisonJson(admission,3,hash));
  assert.throws(()=>readComparisonJson(admission,128,'1'.repeat(64)));
  symlinkSync(admission,join(temp,'link'));
  assert.throws(()=>readComparisonJson(join(temp,'link'),128,hash));
 }finally{rmSync(temp,{force:true,recursive:true});}
});

test('native runtime retirement holds inode and never follows a link', {skip:process.platform!=='linux'},()=>{
 const temp=realpathSync(mkdtempSync(join(tmpdir(),'worker-retire-')));
 const before=process.cwd(),workspace=join(temp,'work'),runtime=join(temp,'runner'),source=join(workspace,'source');
 mkdirSync(source,{recursive:true});mkdirSync(runtime);
 process.chdir(source);
 let files;
 try{
  files=holdWorkerComparisonFiles({GITHUB_WORKSPACE:workspace,RUNNER_TEMP:runtime});
  mkdirSync(join(runtime,'aihr-worker-comparison-next'),{mode:0o700});
  files.holdSeed();
  const first=files.openCell({ordinal:1,name:'steady-2'});
  const build=join(source,'.next');
  mkdirSync(build);
  const target=join(temp,'preserved');
  writeFileSync(target,'private fixture target');
  symlinkSync(target,join(build,'link'));
  const row=lstatSync(build,{bigint:true});
  files.holdBuild(1,{directory:{device:String(row.dev),inode:String(row.ino)}});
  files.retireCell(1,comparisonClock()+10000);
  assert(!existsSync(first.focusedEvidence)&&!existsSync(first.privateDir)&&!existsSync(build)&&existsSync(target));

  const second=files.openCell({ordinal:2,name:'steady-4'});
  mkdirSync(build);
  const other=lstatSync(build,{bigint:true});
  files.holdBuild(2,{directory:{device:String(other.dev),inode:String(other.ino)}});
  renameSync(build,join(source,'.next-previous'));
  mkdirSync(build);
  assert.throws(()=>files.retireCell(2,comparisonClock()+10000),/name changed/);
  assert(existsSync(second.focusedEvidence)&&existsSync(build)&&existsSync(join(source,'.next-previous')));
 }finally{
  files?.close();
  process.chdir(before);
  rmSync(temp,{force:true,recursive:true});
 }
});
