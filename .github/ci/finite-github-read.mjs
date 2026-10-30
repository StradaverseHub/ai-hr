/** Finite read-only GitHub metadata transport; retries never adjudicate evidence. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {REPOSITORY} from './release-policy.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function envelope(raw){
 const text=String(raw??''),match=/^HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) ([1-5][0-9]{2})(?: [^\r\n]*)?\r?\n/.exec(text),split=/\r?\n\r?\n/.exec(text);
 assert(match&&split&&split.index<=32768,'Authoritative bounded GitHub HTTP envelope required');return {status:Number(match[1]),body:text.slice(split.index+split[0].length)};
}
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
export function finiteGithubJson(path,{execute=execFileSync,sleep=pause,audit=record=>process.stderr.write(JSON.stringify(record)+'\n')}={}){
 assert(typeof path==='string'&&path.length<=2048&&!/[\s#%]/.test(path)&&!path.includes('..'),'Exact repository metadata GET path required');
 const parts=path.split('?');assert(parts.length<=2,'Exact repository metadata GET path required');const [pathname,query='']=parts;
 const single=/^actions\/runs\/[1-9][0-9]*$/.test(pathname)||/^actions\/workflows\/(?:[1-9][0-9]*|[A-Za-z0-9_-]+\.ya?ml)$/.test(pathname)||/^git\/ref\/heads\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(pathname);
 const jobs=/^actions\/runs\/[1-9][0-9]*\/jobs$/.test(pathname),inventory=jobs||/^actions\/runs\/[1-9][0-9]*\/artifacts$/.test(pathname)||/^actions\/workflows\/(?:[1-9][0-9]*|[A-Za-z0-9_-]+\.ya?ml)\/runs$/.test(pathname);
 assert(single||inventory,'Exact repository metadata GET path required');assert(!single||query==='','Exact repository metadata GET path required');
 const params=[...new URLSearchParams(query)];assert(new Set(params.map(([key])=>key)).size===params.length,'Exact repository metadata GET path required');
 for(const [key,value] of params)assert((['page','per_page'].includes(key)&&/^[1-9][0-9]*$/.test(value)&&Number(value)<=100)||(jobs&&key==='filter'&&value==='all'),'Exact repository metadata GET path required');
 const route=`repos/${REPOSITORY}/${path}`,requestSha256=hash(route);
 for(let attempt=1;attempt<=3;attempt++){
  let bytes;
  try{bytes=execute('gh',['api','--method','GET','--include',route],{encoding:'utf8',timeout:30000,maxBuffer:32*1024**2});}
  catch(error){
   const stderr=Buffer.from(error?.stderr??'');let status=null;try{status=envelope(error.stdout).status;}catch{}const retry=[502,503,504].includes(status)&&attempt<3;
   audit({kind:'FINITE_GITHUB_GET_TRANSPORT_FAILURE_NOT_EVIDENCE',requestSha256,attempt,status,retry,stderrBytes:stderr.length,stderrSha256:hash(stderr),releaseAuthorized:false});
   if(!retry)throw Error('Finite GitHub metadata GET refused; original transport failure recorded');
   sleep([250,1000][attempt-1]);continue;
  }
  const response=envelope(bytes);assert(response.status>=200&&response.status<300,'Unexpected GitHub HTTP success envelope');
  try{return JSON.parse(response.body);}catch{throw Error('Invalid GitHub metadata JSON; refusing without retry');}
 }
 throw Error('Finite metadata attempt bound exceeded');
}
export function finiteGithubPages(path,key,{read=finiteGithubJson}={}){
 assert(['jobs','artifacts'].includes(key),'Exact metadata inventory required');
 const size=key==='jobs'?25:100,limit=1000,rows=[],ids=new Set();let total=null;
 for(let page=1;page<=limit/size;page++){
  const data=read(`${path}${path.includes('?')?'&':'?'}per_page=${size}&page=${page}`);
  assert(Number.isSafeInteger(data.total_count)&&data.total_count>=0&&data.total_count<=limit&&Array.isArray(data[key])&&data[key].length<=size,'Bounded complete inventory required');
  if(total===null)total=data.total_count;assert(total===data.total_count,'Metadata inventory changed during pagination');
  for(const row of data[key]){assert(Number.isSafeInteger(row.id)&&row.id>0&&!ids.has(row.id),'Duplicate or invalid metadata identity');ids.add(row.id);rows.push(row);}
  if(rows.length===total)return rows;
  assert(data[key].length===size&&rows.length<total,'Metadata pagination omitted identities');
 }
 throw Error('Metadata page bound exceeded');
}
