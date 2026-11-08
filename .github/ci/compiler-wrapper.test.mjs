/** Execute the real wrapper using only fake resource/compiler commands. Never start a compiler or mutate swap. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('actual whole-cache shell branch runs only its intended compiler helper and preserves nonzero exits',()=>{
 for(const code of [0,2]){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'compiler-wrapper-')));
  try{
   const scripts={
    uname:'#!/bin/sh\nprintf "Linux\\n"\n',
    free:'#!/bin/sh\nexit 0\n',
    cat:'#!/bin/sh\n[ "$1" = /proc/swaps ] || exit 95\nprintf "Filename Type Size Used Priority\\n"\n',
    df:'#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 75085112 1000 34277480 55%% /\\n"\n',
    awk:'#!/bin/sh\ncase "$1" in *MemTotal*) printf "16000000\\n";; *SwapTotal*) printf "0\\n";; -v) printf "0\\n";; *) exit 94;; esac\n',
    sudo:'#!/bin/sh\nprintf "forbidden resource operation\\n" >> "$MOCK_TRACE"\nexit 93\n',
    pnpm:'#!/bin/sh\nprintf "forbidden pnpm\\n" >> "$MOCK_TRACE"\nexit 92\n',
    node:'#!/bin/sh\n[ "$#" = 1 ] || exit 91\ncase "$1" in */.github/ci/compiler-cache.mjs) printf "%s\\n" "$1" >> "$MOCK_TRACE"; exit "$MOCK_COMPILER_EXIT";; *) exit 90;; esac\n',
   };
   for(const [name,body]of Object.entries(scripts))writeFileSync(join(dir,name),body,{mode:0o700});
   const trace=join(dir,'trace'),env={...process.env,PATH:dir+':/usr/bin:/bin',RUNNER_TEMP:dir,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',
    GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_CAPACITY_PROFILE:'legacy',MOCK_TRACE:trace,MOCK_COMPILER_EXIT:String(code)};
   const wrapper=fileURLToPath(new URL('./typecheck.sh',import.meta.url));
   const result=spawnSync('/bin/bash',[wrapper,'--whole-cache'],{env,encoding:'utf8',timeout:5000});
   assert.equal(result.status,code,result.stdout+'\n'+result.stderr);
   assert.equal(result.signal,null);
   assert.deepEqual(readFileSync(trace,'utf8').trim().split('\n'),[fileURLToPath(new URL('./compiler-cache.mjs',import.meta.url))]);
   const cleanup=JSON.parse(readFileSync(join(dir,'compiler-transport-swap-cleanup.json'),'utf8'));
   assert.equal(cleanup.mode,'--whole-cache');assert.equal(cleanup.originalCommandExit,code);assert.equal(cleanup.cleanupExit,0);
   assert.equal(cleanup.ownedSwap,0);assert.equal(cleanup.ownedFile,0);assert.equal(cleanup.fileAbsent,true);assert.equal(cleanup.swapAbsent,true);
   assert(!existsSync(join(dir,'aihr-tsc-123-1.swap')));
  }finally{rmSync(dir,{recursive:true});}
 }
});

/** Executes only the real shell using fixed fake compiler/resource commands. */
function traceWrapperFixture({code=0,active='0',foreignFile=false,args=['--full-trace'],profile='legacy'}={}){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'compiler-full-trace-wrapper-'))),trace=join(dir,'trace');
 const scripts={
  uname:'#!/bin/sh\nprintf "Linux\\n"\n',
  free:'#!/bin/sh\nexit 0\n',
  cat:'#!/bin/sh\n[ "$1" = /proc/swaps ] || exit 95\nprintf "Filename Type Size Used Priority\\n"\n',
  df:'#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 75085112 1000 34277480 55%% /\\n"\n',
  awk:'#!/bin/sh\ncase "$1" in *MemTotal*) printf "16000000\\n";; *SwapTotal*) printf "0\\n";; -v) printf "%s\\n" "$MOCK_SWAP_ACTIVE";; *) exit 94;; esac\n',
  sudo:'#!/bin/sh\nprintf "forbidden resource operation\\n" >> "$MOCK_TRACE"\nexit 93\n',
  pnpm:'#!/bin/sh\nprintf "forbidden compiler pnpm\\n" >> "$MOCK_TRACE"\nexit 92\n',
  node:'#!/bin/sh\n[ "$#" = 1 ] || exit 91\ncase "$1" in */.github/ci/diagnostics/compiler-full-trace.mjs) printf "%s\\n" "$1" >> "$MOCK_TRACE"; exit "$MOCK_COMPILER_EXIT";; *) exit 90;; esac\n',
 };
 for(const[name,body]of Object.entries(scripts))writeFileSync(join(dir,name),body,{mode:0o700});
 const foreign=join(dir,'aihr-tsc-123-1.swap');if(foreignFile)writeFileSync(foreign,'foreign retained file',{mode:0o600});
 const env={...process.env,PATH:dir+':/usr/bin:/bin',RUNNER_TEMP:dir,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',
  GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_CAPACITY_PROFILE:profile,MOCK_TRACE:trace,
  MOCK_COMPILER_EXIT:String(code),MOCK_SWAP_ACTIVE:active};
 const result=spawnSync('/bin/bash',[fileURLToPath(new URL('./typecheck.sh',import.meta.url)),...args],
  {env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
 return {dir,trace,foreign,result,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('actual full-trace shell dispatch preserves exact helper and actual nonzero compiler exits',()=>{
 for(const code of [0,2,134]){
  const f=traceWrapperFixture({code});
  try{
   assert.equal(f.result.signal,null);assert.equal(f.result.status,code,f.result.stdout+'\n'+f.result.stderr);
   assert.deepEqual(readFileSync(f.trace,'utf8').trim().split('\n'),
    [fileURLToPath(new URL('./diagnostics/compiler-full-trace.mjs',import.meta.url))]);
   const receipt=JSON.parse(readFileSync(join(f.dir,'compiler-transport-swap-cleanup.json'),'utf8'));
   assert.equal(receipt.mode,'--full-trace');assert.equal(receipt.originalCommandExit,code);
   assert.equal(receipt.cleanupExit,0);assert.equal(receipt.swapAbsent,true);assert.equal(receipt.fileAbsent,true);
  }finally{f.cleanup();}
 }
});
test('actual trace EXIT trap cannot turn unknown swap or foreign-file cleanup into successful compilation',()=>{
 for(const [active,foreignFile]of [['1',false],['0',true]]){
  for(const code of [0,2]){
   const f=traceWrapperFixture({active,foreignFile,code});
   try{
    assert.equal(f.result.signal,null);assert.equal(f.result.status,code===0?1:code);
    const receipt=JSON.parse(readFileSync(join(f.dir,'compiler-transport-swap-cleanup.json'),'utf8'));
    assert.equal(receipt.originalCommandExit,code);assert.equal(receipt.cleanupExit,1);
    if(active==='1')assert.equal(receipt.swapAbsent,false);
    if(foreignFile){assert.equal(receipt.fileAbsent,false);assert.equal(readFileSync(f.foreign,'utf8'),'foreign retained file');}
    assert(!readFileSync(f.trace,'utf8').includes('forbidden resource operation'));
   }finally{f.cleanup();}
  }
 }
});
test('unknown/extra trace arguments and incompatible capacity refuse before resource or compiler execution',()=>{
 for(const options of [{args:['--unknown']},{args:['--full-trace','extra']},{args:['--whole-cache','extra']},
  {profile:'bounded-whole-compiler'},{profile:'bounded-compiler-diagnostic'}]){
  const f=traceWrapperFixture(options);
  try{assert.equal(f.result.status,2);assert.equal(f.result.signal,null);assert(!existsSync(f.trace));
   assert(!existsSync(join(f.dir,'compiler-transport-swap-cleanup.json')));
  }finally{f.cleanup();}
 }
});
