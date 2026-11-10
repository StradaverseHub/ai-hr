/** Execute the real wrapper using only fake resource/compiler commands. Never start a compiler or mutate swap. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('actual whole-cache shell branch runs only its intended compilers in order and preserves nonzero exits',()=>{
 for(const [code,harness] of [[0,0],[2,0],[0,2]]){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'compiler-wrapper-')));
  try{
   const scripts={
    uname:'#!/bin/sh\nprintf "Linux\\n"\n',
    free:'#!/bin/sh\nexit 0\n',
    cat:'#!/bin/sh\n[ "$1" = /proc/swaps ] || exit 95\nprintf "Filename Type Size Used Priority\\n"\n',
    df:'#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 75085112 1000 34277480 55%% /\\n"\n',
    awk:'#!/bin/sh\ncase "$1" in *MemTotal*) printf "16000000\\n";; *SwapTotal*) printf "0\\n";; -v) printf "0\\n";; *) exit 94;; esac\n',
    sudo:'#!/bin/sh\nprintf "forbidden resource operation\\n" >> "$MOCK_TRACE"\nexit 93\n',
    pnpm:'#!/bin/sh\n[ "$*" = "exec tsc -b test/tsconfig.json" ] || { printf "forbidden pnpm\\n" >> "$MOCK_TRACE"; exit 92; }\nprintf "pnpm %s\\n" "$*" >> "$MOCK_TRACE"\nexit "$MOCK_HARNESS_EXIT"\n',
    node:'#!/bin/sh\n[ "$#" = 1 ] || exit 91\ncase "$1" in */.github/ci/compiler-cache.mjs) printf "%s\\n" "$1" >> "$MOCK_TRACE"; exit "$MOCK_COMPILER_EXIT";; *) exit 90;; esac\n',
   };
   for(const [name,body]of Object.entries(scripts))writeFileSync(join(dir,name),body,{mode:0o700});
   const trace=join(dir,'trace'),env={...process.env,PATH:dir+':/usr/bin:/bin',RUNNER_TEMP:dir,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',
    GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_CAPACITY_PROFILE:'legacy',MOCK_TRACE:trace,MOCK_COMPILER_EXIT:String(code),MOCK_HARNESS_EXIT:String(harness)};
   const wrapper=fileURLToPath(new URL('./typecheck.sh',import.meta.url));
   const result=spawnSync('/bin/bash',[wrapper,'--whole-cache'],{env,encoding:'utf8',timeout:5000});
   assert.equal(result.status,code||harness,result.stdout+'\n'+result.stderr);
   assert.equal(result.signal,null);
   // The test project runs only after the product compiler succeeds, and its own failure is the result.
   const cache=fileURLToPath(new URL('./compiler-cache.mjs',import.meta.url));
   assert.deepEqual(readFileSync(trace,'utf8').trim().split('\n'),code===0?[cache,'pnpm exec tsc -b test/tsconfig.json']:[cache]);
   const cleanup=JSON.parse(readFileSync(join(dir,'compiler-transport-swap-cleanup.json'),'utf8'));
   assert.equal(cleanup.mode,'--whole-cache');assert.equal(cleanup.originalCommandExit,code||harness);assert.equal(cleanup.cleanupExit,0);
   assert.equal(cleanup.ownedSwap,0);assert.equal(cleanup.ownedFile,0);assert.equal(cleanup.fileAbsent,true);assert.equal(cleanup.swapAbsent,true);
   assert(!existsSync(join(dir,'aihr-tsc-123-1.swap')));
  }finally{rmSync(dir,{recursive:true});}
 }
});
