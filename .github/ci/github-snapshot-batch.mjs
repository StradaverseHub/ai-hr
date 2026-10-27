/** Bounded parallel metadata transport. Origin/outcome authority remains with the existing inspectors. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),repository='StradaverseHub/ai-hr';
export async function collectRunSnapshots(ids,readJson,workers=4){
 assert(Array.isArray(ids)&&ids.length>0&&ids.length<=64&&ids.every(i=>Number.isSafeInteger(i)&&i>0)&&new Set(ids).size===ids.length,'Bounded unique actual run IDs required');
 assert(Number.isSafeInteger(workers)&&workers>=1&&workers<=4,'Bounded metadata worker count required');
 const result=new Map();let cursor=0;
 async function rows(path,key){const out=[];for(let page=1;page<=10;page++){const value=await readJson(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);assert(Array.isArray(value[key])&&value[key].length<=100,'Missing/oversized metadata page');out.push(...value[key]);if(value[key].length<100)return out;}throw Error('API inventory exceeds bound');}
 await Promise.all(Array.from({length:Math.min(workers,ids.length)},async()=>{for(;;){const index=cursor++;if(index>=ids.length)return;const id=ids[index],root='actions/runs/'+id;const [run,jobs,artifacts]=await Promise.all([readJson(root),rows(root+'/jobs?filter=all','jobs'),rows(root+'/artifacts','artifacts')]);assert.equal(run.id,id,'Metadata transport returned another run');result.set(id,{run,jobs,artifacts});}}));
 assert.equal(result.size,ids.length);return result;
}
export async function fetchRunSnapshots(ids){
 return collectRunSnapshots(ids,async path=>{const {stdout}=await exec('gh',['api','repos/'+repository+'/'+path],{encoding:'utf8',maxBuffer:128*1024**2,timeout:60000});return JSON.parse(stdout);});
}
