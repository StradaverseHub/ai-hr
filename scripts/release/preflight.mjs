/** ADR-0175 pre-binding preflight. Advisory and read-only: it never writes the checkout, never issues a
 * receipt, witness, grant or approval, and CI admission (.github/ci/ai-manifest-admission.mjs) is unchanged.
 *
 *   node scripts/release/preflight.mjs [--head HEAD] [--base origin/main] [--staging-watermark WHEN] [--json]
 *
 * It answers, before the owner is asked to approve a packet, the questions the full gate would otherwise
 * answer after ~20 minutes:
 *   1. generator: are the AI manifest generator/scope files byte-identical to the base (the next controller)?
 *   2. closures: the provider-data and module-agent closures of HEAD and base, and the file delta between them
 *      (the approval delta for the packet), plus whether HEAD's committed manifests are already bound;
 *   3. migrations: is base's journal an exact prefix, and is every new `when`/`idx` above base and the
 *      recorded staging watermark (a lower `when` is silently skipped by the migrator)?
 * Exit code 1 means the full gate would refuse or the migrator could skip; 0 means nothing found here. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AI_MANIFEST_INPUTS} from '../../.github/ci/ai-manifest-admission.mjs';

const JOURNAL='db/migrations/meta/_journal.json';
const GENERATORS={provider:'scripts/ai-provider-data-source-manifest.mjs',moduleAgent:'scripts/ai-agent-source-manifest.mjs'};
const git=(args,options={})=>execFileSync('git',args,{encoding:'utf8',maxBuffer:256*1024**2,...options});
const blob=(rev,path)=>{try{return execFileSync('git',['show',`${rev}:${path}`],{maxBuffer:64*1024**2,stdio:['ignore','pipe','ignore']});}catch{return null;}};

/** @param {string} headRev @param {string} baseRev @param {(rev:string,path:string)=>Buffer|null} [read] */
export function compareGenerators(headRev,baseRev,read=blob){
  return AI_MANIFEST_INPUTS.map(path=>{
    const head=read(headRev,path),base=read(baseRev,path);
    return {path,identical:head!==null&&base!==null&&Buffer.compare(head,base)===0};
  });
}

/** Classify a closure file by what kind of change it represents for the owner's approval delta.
 * @param {string} path */
export function classifyClosureFile(path){
  if(/^messages\/.+\.json$/.test(path))return 'locale catalogue';
  if(path==='package.json'||path==='pnpm-lock.yaml')return 'dependencies';
  if(/(^|\/)(provider|egress|transport|openrouter|azure)[^/]*\.(ts|mjs)$/.test(path)||path.startsWith('lib/ai/providers/'))return 'provider transport/egress';
  if(/provider-data|disclosure|semantic|entities|contract/.test(path))return 'disclosure contract/entity';
  if(/(^|\/)(spec|prompt|tools?|tool-catalogue)[^/]*\.(ts|tsx)$/.test(path)||path.includes('/harness/'))return 'spec/harness/tools';
  if(path.startsWith('lib/ai/')||/^core\/(teras|assistant|ai-|agent-|harness)/.test(path))return 'AI code';
  if(/\.(tsx)$/.test(path)||path.startsWith('components/')||path.startsWith('app/'))return 'UI';
  if(path.startsWith('db/'))return 'schema';
  if(path.startsWith('packs/'))return 'country pack service';
  if(path.startsWith('core/'))return 'HR core service';
  return 'other';
}

/** @typedef {{sources:{path:string,sha256:string}[]}} ClosureSources
 * @param {ClosureSources} base @param {ClosureSources} head */
export function closureDelta(base,head){
  const before=new Map(base.sources.map(s=>[s.path,s.sha256])),after=new Map(head.sources.map(s=>[s.path,s.sha256]));
  /** @type {{path:string,change:string}[]} */
  const rows=[];
  for(const [path,sha]of after)if(!before.has(path))rows.push({path,change:'added'});else if(before.get(path)!==sha)rows.push({path,change:'changed'});
  for(const path of before.keys())if(!after.has(path))rows.push({path,change:'removed'});
  return rows.sort((a,b)=>a.path.localeCompare(b.path)).map(r=>({...r,kind:classifyClosureFile(r.path)}));
}

/** @typedef {{tag:string,idx:number,when:number}} JournalEntry
 * @param {JournalEntry[]} baseEntries @param {JournalEntry[]} headEntries
 * @param {{stagingWatermark?:number|null,sqlExists?:(tag:string)=>boolean}} [options] */
export function migrationProblems(baseEntries,headEntries,{stagingWatermark=null,sqlExists=()=>true}={}){
  /** @type {string[]} */
  const problems=[];
  /** @type {string[]} */
  const added=[];
  baseEntries.forEach((entry,i)=>{
    const h=headEntries[i];
    if(!h||h.tag!==entry.tag||h.when!==entry.when||h.idx!==entry.idx)problems.push(`Base journal entry ${i} (${entry.tag}) is not an exact prefix of HEAD`);
  });
  const maxWhen=Math.max(-1,...baseEntries.map(e=>e.when),stagingWatermark??-1),maxIdx=Math.max(-1,...baseEntries.map(e=>e.idx));
  let lastWhen=maxWhen,lastIdx=maxIdx;const tags=new Set(baseEntries.map(e=>e.tag));
  for(const entry of headEntries.slice(baseEntries.length)){
    added.push(entry.tag);
    if(tags.has(entry.tag))problems.push(`Duplicate migration tag ${entry.tag}`);
    tags.add(entry.tag);
    if(!(entry.when>lastWhen))problems.push(`${entry.tag}: when ${entry.when} is not above ${lastWhen} (base/staging watermark or previous new entry); the migrator would skip it`);
    if(!(entry.idx>lastIdx))problems.push(`${entry.tag}: idx ${entry.idx} is not above ${lastIdx}`);
    if(!sqlExists(entry.tag))problems.push(`${entry.tag}: SQL file missing`);
    lastWhen=Math.max(lastWhen,entry.when);lastIdx=Math.max(lastIdx,entry.idx);
  }
  return {added,problems,baseMaxWhen:maxWhen,baseMaxIdx:maxIdx};
}

/** Extract one revision and run both generators there (write mode, inside the throwaway copy only). */
function closures(rev){
  const dir=mkdtempSync(join(tmpdir(),'aihr-preflight-'));
  try{
    execFileSync('sh',['-c','git archive "$1" | tar -x -C "$2"','sh',rev,dir],{stdio:['ignore','ignore','inherit'],maxBuffer:1024});
    // The module-agent scope lists files through git; a fresh repository lists exactly the archived files.
    execFileSync('git',['init','-q'],{cwd:dir});
    const bound={};
    for(const [name,script]of Object.entries(GENERATORS)){
      try{execFileSync(process.execPath,[script,'--check'],{cwd:dir,stdio:'ignore',timeout:120000});bound[name]=true;}catch{bound[name]=false;}
    }
    const provider=JSON.parse(execFileSync(process.execPath,[GENERATORS.provider,'--list'],{cwd:dir,encoding:'utf8',timeout:120000,maxBuffer:64*1024**2}));
    const moduleAgent=JSON.parse(execFileSync(process.execPath,[GENERATORS.moduleAgent],{cwd:dir,encoding:'utf8',timeout:120000}));
    const hashOf=p=>createHash('sha256').update(readFileSync(join(dir,p))).digest('hex');
    return {rev,bound,provider:{files:provider.files,digest:provider.digest,sources:provider.sources.map(path=>({path,sha256:hashOf(path)}))},moduleAgent};
  }finally{rmSync(dir,{recursive:true,force:true});}
}

function main(){
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const baseRef=option('--base')??'origin/main',watermark=option('--staging-watermark');
  const headRef=option('--head')??'HEAD',head=git(['rev-parse',headRef]).trim(),base=git(['rev-parse',baseRef]).trim();
  const dirty=headRef==='HEAD'&&git(['status','--porcelain']).trim().length>0;
  const generators=compareGenerators(head,base);
  const [h,b]=[closures(head),closures(base)];
  const delta=closureDelta(b.provider,h.provider);
  const journal=rev=>JSON.parse(blob(rev,JOURNAL)?.toString('utf8')??'{"entries":[]}').entries;
  const migrations=migrationProblems(journal(base),journal(head),{stagingWatermark:watermark==null?null:Number(watermark),sqlExists:tag=>blob(head,`db/migrations/${tag}.sql`)!==null});
  const failures=[
    ...generators.filter(g=>!g.identical).map(g=>`Generator/scope differs from ${baseRef}: ${g.path} (CI admission refuses this at plan and build)`),
    ...migrations.problems,
  ];
  const report={kind:'ADVISORY_PREFLIGHT_NOT_EVIDENCE',releaseAuthorized:false,head,base,baseRef,dirty,generators,
    closures:{
      provider:{head:{files:h.provider.files,digest:h.provider.digest,bound:h.bound.provider},base:{files:b.provider.files,digest:b.provider.digest,bound:b.bound.provider}},
      moduleAgent:{head:{...h.moduleAgent,bound:h.bound.moduleAgent},base:{...b.moduleAgent,bound:b.bound.moduleAgent}},
      providerDelta:delta,
    },
    migrations,failures};
  if(args.includes('--json')){process.stdout.write(JSON.stringify(report,null,2)+'\n');}
  else{
    const kinds={};for(const d of delta)kinds[d.kind]=(kinds[d.kind]??0)+1;
    console.log(`Preflight (advisory) HEAD ${head.slice(0,12)} against ${baseRef} ${base.slice(0,12)}${dirty?' — WARNING: uncommitted changes are not included':''}`);
    console.log(`  generator/scope: ${generators.every(g=>g.identical)?'identical to base':'DIFFERS'}`);
    console.log(`  provider closure: ${h.provider.files} files ${h.provider.digest.slice(0,8)} (base ${b.provider.files} ${b.provider.digest.slice(0,8)}); committed manifest ${h.bound.provider?'bound':'NOT bound (expected before the owner binding)'}`);
    console.log(`  module-agent: ${h.moduleAgent.files} files ${h.moduleAgent.digest.slice(0,8)} (base ${b.moduleAgent.digest.slice(0,8)}); committed manifest ${h.bound.moduleAgent?'bound':'NOT bound'}`);
    console.log(`  approval delta: ${delta.length} closure files — ${Object.entries(kinds).map(([k,n])=>`${n} ${k}`).join(', ')||'none'}`);
    for(const d of delta)console.log(`    ${d.change.padEnd(7)} ${d.kind.padEnd(27)} ${d.path}`);
    console.log(`  migrations: ${migrations.added.length} new (${migrations.added.join(', ')||'none'}); base max when ${migrations.baseMaxWhen}${watermark?' incl. staging watermark':' (no staging watermark given)'}`);
    for(const f of failures)console.log('  FAIL '+f);
    console.log(failures.length?'Preflight found problems the full gate or migrator would hit.':'Preflight found nothing; this is not release evidence.');
  }
  process.exitCode=failures.length?1:0;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();
