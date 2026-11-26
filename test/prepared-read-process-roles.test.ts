/** Which processes can send the named prepared reads of db/prepared-read.ts, so the retained plan bound
 * (PREPARED_READ_BACKEND_BOUND_BYTES, per backend) is stated for every process role (ADR 0181 decision 9).
 *
 * `executePrepared` limits the texts of each statement per process, whatever the role, so every backend is bounded.
 * This test also pins which non-web entry points can reach a named read at all: it follows the static and dynamic
 * imports of each worker and scheduled entry point and fails if one reaches a module that calls a named-read owner
 * (or registers or declares a request preamble, whose identity statement is the named request-preamble read) beyond
 * what is listed here. The import worker and its lanes reach none; the payroll loop tick and the nightly review sweep
 * reach only the payroll freshness reads (one text each). A new entry point or import that changes this fails here. */
import {readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,join,normalize,relative} from 'node:path';
import {describe,expect,it} from 'vitest';

const root=process.cwd();
const IMPORT=/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+|@\/[^'"]+)['"]|import\(\s*['"](\.[^'"]+|@\/[^'"]+)['"]\s*\)|^\s*import\s*['"](\.[^'"]+|@\/[^'"]+)['"]/gm;
function resolve(from:string,spec:string):string|null{
 const base=spec.startsWith('@/')?join(root,spec.slice(2)):normalize(join(dirname(from),spec));
 for(const candidate of [base,base+'.ts',base+'.tsx',base+'.mts',base+'.mjs',base+'.js',join(base,'index.ts'),join(base,'index.tsx')])
  if(existsSync(candidate)&&!candidate.endsWith('/'))try{readFileSync(candidate);return candidate;}catch{/* a directory */}
 if(base.endsWith('.js')&&existsSync(base.slice(0,-3)+'.ts'))return base.slice(0,-3)+'.ts';
 return null;
}
function reachable(entry:string):Set<string>{
 const seen=new Set<string>(),stack=[join(root,entry)];
 while(stack.length){
  const file=stack.pop()!;
  if(seen.has(file))continue;
  seen.add(file);
  let text='';try{text=readFileSync(file,'utf8');}catch{continue;}
  for(const match of text.matchAll(IMPORT)){
   const target=resolve(file,(match[1]??match[2]??match[3])!);
   if(target&&!seen.has(target))stack.push(target);
  }
 }
 return new Set([...seen].map(file=>relative(root,file)));
}

/** Each named-read owner (the function that calls executePrepared) and the module that defines it. */
const OWNERS={readAccountTaskBundle:'core/account-task-bundle.ts',readBeforePayrollBundle:'core/pre-salary/before-payroll-bundle.ts',
 recruitmentTodos:'packs/recruitment/tasks.ts',payrollChangedCompanies:'core/loops/payroll-freshness.ts'} as const;
type Reader=keyof typeof OWNERS|'requestPreamble';
const sources=execFileSync('git',['ls-files','*.ts','*.tsx','*.mts'],{cwd:root,encoding:'utf8'}).split('\n').filter(file=>file&&!file.startsWith('test/'));
function callers():Record<Reader,string[]>{
 const out={} as Record<Reader,string[]>;
 for(const [name,home] of Object.entries(OWNERS)){
  const call=new RegExp(`\\b${name}\\s*[(<]`);
  out[name as Reader]=sources.filter(file=>file!==home&&call.test(readFileSync(join(root,file),'utf8')));
 }
 out.requestPreamble=sources.filter(file=>!file.startsWith('db/')&&/\b(registerRequestScopePreamble|declareSharedReadPreamble)\s*\(/.test(readFileSync(join(root,file),'utf8')));
 return out;
}

/** Worker and scheduled entry points (deploy/systemd, deploy/scheduled-jobs, the staging crontab), and the named reads
 * each may reach. Everything else they reach must call no named-read owner. */
const ENTRIES:Record<string,readonly Reader[]>={
 'scripts/bank-import-runner.ts':[],
 'scripts/lib/worker-lane-process.ts':[],
 'scripts/notification-email-sweep.ts':[],
 'scripts/payroll-loop-tick.ts':['payrollChangedCompanies'],
 'scripts/review-sweep.ts':['payrollChangedCompanies'],
 'scripts/access-effective-company-check.ts':[],
 'scripts/accrue-earned.ts':[],
 'scripts/anomaly-sweep.ts':[],
 'scripts/capture-usage.ts':[],
 'scripts/entitlement-alarm.ts':[],
 'scripts/expire-carry.ts':[],
 'scripts/payroll-read-access-check.ts':[],
 'scripts/provision-runner.ts':[],
 'scripts/resync-child-relief-grid.ts':[],
};

describe('named prepared reads by process role',()=>{
 const found=callers();
 it('knows every named-read owner\'s callers, and they are web code',()=>{
  // Nonempty: the trace looks for real call sites, not an empty list.
  for(const reader of Object.keys(found) as Reader[])expect(found[reader].length,reader).toBeGreaterThan(0);
  expect(found.recruitmentTodos).toEqual(['app/recruitment/tasks-panel.tsx']);
 });
 it.each(Object.entries(ENTRIES))('%s reaches only the named reads listed for it',(entry,allowed)=>{
  const modules=reachable(entry);
  expect(modules.size,entry).toBeGreaterThan(1);
  const reached=(Object.keys(found) as Reader[]).filter(reader=>found[reader].some(file=>modules.has(file)));
  expect(reached.sort(),entry).toEqual([...allowed].sort());
 });
});
