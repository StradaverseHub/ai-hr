import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeInputs} from './runtime-inputs';
const files=new Map([['data/a.json','{}'],['lib/a.ts','']]);
test('literal URL source reads bind actual resource bytes',()=>{const r=runtimeInputs('lib/a.ts',"import {readFileSync} from 'node:fs'; const x=readFileSync(new URL('../data/a.json',import.meta.url));",files);assert.deepEqual(r,{opaque:false,dependencies:['data/a.json']});});
test('computed reads, escaping readers and shadowed aliases cannot receive narrow reuse',()=>{for(const src of ["import {readFileSync} from 'node:fs';readFileSync(process.env.FILE);","import {readFileSync} from 'node:fs';const fn=readFileSync;", "import {readFileSync} from 'node:fs';function f(readFileSync:any){readFileSync('data/a.json')}","import * as fs from 'node:fs';fs.readFileSync('data/a.json');","import {readdirSync} from 'node:fs';readdirSync('app');", "import {readFileSync} from 'node:fs'; readFileSync('../../etc/passwd');"])assert(runtimeInputs('lib/a.ts',src,files).opaque,src);});
test('dynamic loading, network, process spawning and clocks require fresh execution',()=>{for(const src of ["import(name)","require(name)","fetch('/api')","Date.now()","new Date()","Math.random()","import {execFileSync} from 'node:child_process';"])assert(runtimeInputs('lib/a.ts',src,files).opaque,src);});
test('ordinary imports, fixed dates and unrelated prose do not invent mutable inputs',()=>{assert(!runtimeInputs('lib/a.ts',"import x from './x';const d=new Date('2026-01-01');",files).opaque);});
