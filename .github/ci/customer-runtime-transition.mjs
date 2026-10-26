/** Private proposal construction only. No SSH, host writes, installation or release authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const CUSTOMER_ENV_DELTA_KEYS=Object.freeze(['DEV_TENANT_ID','DEV_USER_ID','AUDIT_HASH_CHAIN_ENABLED']);
const bounded=bytes=>{assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=1024**2&&!bytes.includes(0),'Bounded private environment bytes required');const text=bytes.toString('utf8');assert(Buffer.from(text).equals(bytes),'Private environment must be valid UTF8');return text;};
function literalEnvironment(bytes){
 const text=bounded(bytes);assert(!text.includes('\r'),'Unsupported CRLF private environment; no normalization is permitted');
 const assignment=/^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=(?:'[^'\r\n]*'|"(?:[^"\\$`\r\n]|\\[^\r\n])*"|[A-Za-z0-9_./:@%+=,#?!\[\]-]*)[ \t]*(?:#[^\r\n]*)?$/;
 assert(text.split('\n').every(line=>/^[ \t]*(?:#.*)?$/.test(line)||assignment.test(line)),'Unsupported literal environment syntax; no shell commands or multiline evaluation permitted');
 return text;
}
/** Evaluate literals with shell builtins only: no Node autoload or dynamic-loader execution. */
export function parsePrivateEnvironment(bytes,{cwd=process.cwd()}={}){
 const text=literalEnvironment(bytes),keys=[...new Set([...text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m=>m[1]))];
 assert(keys.length<=4096&&keys.every(k=>k.length<=160),'Bounded private environment names required');
 const script='set -eu\nset -a\n. /dev/stdin\nset +a\nwhile [ "$#" -gt 0 ]; do builtin printf "%s\\0" "${!1}"; shift; done';
 let raw;
 try{raw=execFileSync('/bin/bash',['--noprofile','--norc','-c',script,'aihr-private-environment',...keys],{cwd,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},input:bytes,timeout:5000,maxBuffer:2*1024**2,stdio:['pipe','pipe','pipe']});}
 catch{throw Error('Private environment could not be evaluated safely; no values returned');}
 const fields=raw.toString('utf8').split('\0');assert(fields.pop()===''&&fields.length===keys.length,'Private environment output differs');
 const values=Object.fromEntries(keys.map((key,index)=>[key,fields[index]]));
 assert(values&&typeof values==='object'&&!Array.isArray(values)&&Object.keys(values).length<=4096&&Object.entries(values).every(([k,v])=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)&&typeof v==='string'),'Invalid parsed private environment');
 return values;
}
export function proposeCustomerEnvironment(original,{parse=parsePrivateEnvironment}={}){
 const text=literalEnvironment(original),lines=text.match(/[^\n]*\n|[^\n]+$/g)??[],removed=[];
 assert(!text.includes('\r'),'Unsupported CRLF private environment; no normalization is permitted');
 assert(!lines.some(line=>/^[ \t]*(?:export[ \t]+)?PATH[ \t]*=/.test(line)),'Private env defines PATH; requires a separately reviewed path proposal');
 const retained=lines.filter(line=>{
  const match=line.match(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*?)(?:\r?\n)?$/);
  if(!match||!CUSTOMER_ENV_DELTA_KEYS.includes(match[1]))return true;
  assert(/^[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z0-9_.:-]*)[ \t]*(?:#[^\r\n]*)?$/.test(match[2]),'Unsupported target-key expression; private proposal refused');
  removed.push(match[1]);return false;
 }).join('');
 const newline=text.includes('\r\n')?'\r\n':'\n';
 const proposed=Buffer.from(retained+(retained&&!retained.endsWith('\n')?newline:'')+'AUDIT_HASH_CHAIN_ENABLED=true'+newline);
 const before=parse(original),after=parse(proposed);
 assert(before.AUTH_PROVIDER==='internal'&&before.ALLOW_DEMO_SESSION!=='true','Current internal customer auth must already be active');
 assert(typeof before.AUTH_SESSION_KEY==='string'&&/^[a-f0-9]{64}$/i.test(before.AUTH_SESSION_KEY)&&typeof before.AUTH_PUBLIC_ORIGIN==='string'&&before.AUTH_PUBLIC_ORIGIN.startsWith('https://'),'Existing origin/key required; proposal never invents them');
 assert(!Object.hasOwn(after,'DEV_TENANT_ID')&&!Object.hasOwn(after,'DEV_USER_ID')&&after.AUDIT_HASH_CHAIN_ENABLED==='true','Exact allowed customer delta required');
 const unaffected=values=>Object.fromEntries(Object.entries(values).filter(([key])=>!CUSTOMER_ENV_DELTA_KEYS.includes(key)).sort(([a],[b])=>a.localeCompare(b)));
 assert(isDeepStrictEqual(unaffected(before),unaffected(after)),'Proposal changed an unrelated effective value');
 return {kind:'PRIVATE_CUSTOMER_ENV_PROPOSAL_NOT_APPLIED',originalSha256:hash(original),proposedSha256:hash(proposed),bytes:proposed,removedKeys:[...new Set(removed)].sort(),setKeys:['AUDIT_HASH_CHAIN_ENABLED'],nonTargetValuesPreserved:true,releaseAuthorized:false};
}
export function proposeCustomerUnit({descriptor,runtimePath,environmentFilePathOverrideAbsent,ordinaryExecStartProved}){
 assert(environmentFilePathOverrideAbsent===true,'Effective environment-file PATH precedence must be proved');
 assert(ordinaryExecStartProved===true,'Original unit executable flags must be proved ordinary');
 assert(typeof descriptor==='string'&&descriptor.length<16384,'Bounded actual unit descriptor required');
 const starts=[...descriptor.matchAll(/(?:^|[;{])\s*path=([^;]+?)\s*;/g)],argv=[...descriptor.matchAll(/argv\[\]=([^;]+?)\s*;/g)];
 assert(starts.length===1&&argv.length===1&&starts[0][1]==='/opt/node20/bin/node','Exact old service executable required');
 const oldArgv=argv[0][1];assert(oldArgv.startsWith('/opt/node20/bin/node /opt/ai-hr/node_modules/next/dist/bin/next start ')&&/^[A-Za-z0-9_./ :\-]+$/.test(oldArgv),'Unreviewed existing service arguments');
 assert(typeof runtimePath==='string'&&runtimePath.length>0&&runtimePath.length<=16384,'Actual service PATH required');
 const components=runtimePath.split(':');assert(components.length<=256&&components.every(p=>path.isAbsolute(p)&&path.normalize(p)===p&&/^\/[A-Za-z0-9_./-]+$/.test(p)),'Unsupported PATH component');
 const targetPath=[...new Set(['/opt/node22/bin',...components])].join(':'),newArgv=oldArgv.replace('/opt/node20/bin/node','/opt/node22/bin/node');
 const bytes=Buffer.from('[Service]\nExecStart=\nExecStart='+newArgv+'\nEnvironment="PATH='+targetPath+'"\nUnsetEnvironment=DEV_TENANT_ID DEV_USER_ID\n');
 return {kind:'PRIVATE_CUSTOMER_UNIT_PROPOSAL_NOT_APPLIED',bytes,sha256:hash(bytes),oldExecutable:'/opt/node20/bin/node',newExecutable:'/opt/node22/bin/node',existingArgumentsPreserved:true,pathPrefixOnly:true,existingEnvironmentSourcesAndHardeningUnchanged:true,releaseAuthorized:false};
}
/** Only this redacted summary belongs in a planning record; private bytes stay in the operator. */
export function summarizeCustomerProposal(environment,unit){
 assert(environment?.kind==='PRIVATE_CUSTOMER_ENV_PROPOSAL_NOT_APPLIED'&&unit?.kind==='PRIVATE_CUSTOMER_UNIT_PROPOSAL_NOT_APPLIED'&&environment.releaseAuthorized===false&&unit.releaseAuthorized===false,'Actual private proposals required');
 assert(hash(environment.bytes)===environment.proposedSha256&&hash(unit.bytes)===unit.sha256,'Proposed private bytes changed');
 return {kind:'CUSTOMER_RUNTIME_PROPOSAL_NOT_APPLIED',environment:{originalSha256:environment.originalSha256,proposedSha256:environment.proposedSha256,remove:['DEV_TENANT_ID','DEV_USER_ID'],set:{AUDIT_HASH_CHAIN_ENABLED:'true'},nonTargetValuesPreserved:true},unit:{sha256:unit.sha256,oldExecutable:unit.oldExecutable,newExecutable:unit.newExecutable,existingArgumentsPreserved:true,existingEnvironmentSourcesAndHardeningUnchanged:true},tenantAuditSettingsChanged:false,historicalAuditCoverageClaimed:false,requiresMatchedTrustedFullWitness:true,requiresHumanMaintenanceGrant:true,releaseAuthorized:false};
}
