/** Read-only admission: both generated source identities must match the frozen candidate. */
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const controllerRoot=fileURLToPath(new URL('../../',import.meta.url));
export const AI_MANIFEST_INPUTS=Object.freeze([
 'scripts/ai-agent-source-manifest.mjs',
 'scripts/ai-agent-source-scope.mjs',
 'scripts/ai-provider-data-source-manifest.mjs',
]);
const checks=['scripts/ai-provider-data-source-manifest.mjs','scripts/ai-agent-source-manifest.mjs'];
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:10000}).trim();
function frozen(cwd,expected){
 const sha=git(cwd,'rev-parse','HEAD');
 if(!/^[0-9a-f]{40}$/.test(expected??'')||sha!==expected||git(cwd,'status','--porcelain'))throw Error('AI manifest admission requires exact clean candidate');
}
export function admitAiManifests(candidatePath,expected){
 const cwd=resolve(candidatePath);frozen(cwd,expected);
 // Execute only the generators/scope already reviewed with this controller. A source-scope or
 // generator change requires its own reviewed controller; candidate code cannot replace --check.
 for(const name of AI_MANIFEST_INPUTS){
  const path=resolve(cwd,name);
  if(!lstatSync(path).isFile()||!readFileSync(path).equals(readFileSync(resolve(controllerRoot,name))))throw Error('Unreviewed AI manifest generator or scope: '+name);
 }
 const results=[],failures=[];
 for(const script of checks){
  try{
   const output=execFileSync(process.execPath,[script,'--check'],{cwd,encoding:'utf8',timeout:60000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
   const value=JSON.parse(output);
   if(!Number.isSafeInteger(value.files)||value.files<1||!/^[0-9a-f]{64}$/.test(value.digest??'')||Object.keys(value).sort().join(',')!=='digest,files')throw Error('Invalid manifest result');
   results.push({script,...value});
  }catch{failures.push(script);}
 }
 frozen(cwd,expected);
 if(failures.length)throw Error('AI manifest --check refused: '+failures.join(', '));
 return {kind:'AI_SOURCE_MANIFEST_ADMISSION',candidate:expected,checks:results,releaseAuthorized:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [path,sha]=process.argv.slice(2);console.log(JSON.stringify(admitAiManifests(path??process.cwd(),sha??process.env.AIHR_CI_HEAD),null,2));
}
