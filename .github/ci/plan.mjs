/** Full CI coverage uses the local gate's classifier, with independent job environments. */
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {singletonSources,singletonSourceMaximum,assertSingletonCoverage,assertAiCentreUpgradeCoverage} from './singleton-protocol.mjs';
import {employeeLifecycleUnit} from './employee-lifecycle-profile.mjs';
import {assertEmployeeLifecycleSourceClosure} from './employee-lifecycle-sources.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {inspectPdfToolScope} from './pdf-tool-scope.mjs';
import {buildUnits,hash,CI_EXECUTION} from './manifest.mjs';
import {candidateEnvironment,nativePreparationEnvironment} from './candidate-environment.mjs';
export {hash};
export function createPlan(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', ['-c','safe.directory='+cwd,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args], {cwd, env:nativePreparationEnvironment(process.env),encoding: 'utf8',timeout:10000,killSignal:'SIGTERM'}).trim();
  const sha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw Error('CI requires a clean candidate');
  if (process.env.AIHR_CI_HEAD && process.env.AIHR_CI_HEAD !== sha) throw Error('CI checkout does not match requested HEAD');
  const tracked = git('ls-files', 'test').split('\n');
  assertAiCentreUpgradeCoverage([...tracked,...git('ls-files','--','db/migrations').split('\n')],file=>{
   const path=resolve(cwd,file),stat=lstatSync(path,{throwIfNoEntry:false});
   if(!stat)return undefined;
   if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(path)!==path||stat.size>singletonSourceMaximum(file))throw Error('Unsafe AI Centre upgrade source');
   return readFileSync(path);
  });
  const suite = tracked.filter(f => /\.test\.ts$|\.dom\.test\.tsx$/.test(f)).sort();
  if (!suite.length) throw Error('Empty test inventory');
  assertSingletonCoverage(suite,file=>readFileSync(resolve(cwd,file),'utf8'));
  const classifierRuntime=process.env.AIHR_CI_CLASSIFIER_RUNTIME??'tsx';
  if(!['tsx','native'].includes(classifierRuntime))throw Error('Unknown classifier runtime');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(classifierRuntime==='native'&&(major!==22||minor<18))throw Error('Native classifier requires Node 22.18+');
  const loader=classifierRuntime==='native'?['--experimental-strip-types']:['--import','tsx'];
  // Bounded candidate classifier. Main-based candidates still carry the pre-graph classifier,
  // measured at ~17 s locally for 3,440 files (v17 had no bound); the graph classifier takes ~3 s.
  const classified = execFileSync(process.execPath, [...loader, 'scripts/gate-db-classify.ts', 'explain'], {
    cwd, env:candidateEnvironment(process.env), timeout:60000,killSignal:'SIGTERM', input: suite.join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trim().split('\n').map(line => line.split('\t'));
  const groups = {nodb: [], db: []};
  for (const [kind, file] of classified) {
    if (!['DB', 'NODB'].includes(kind) || !suite.includes(file)) throw Error('Invalid classifier output');
    groups[kind === 'DB' ? 'db' : 'nodb'].push(file);
  }
  if (JSON.stringify([...groups.db, ...groups.nodb].sort()) !== JSON.stringify(suite)) throw Error('Classifier does not partition the suite exactly');
  const browsers = tracked.filter(f => f.endsWith('.browser.test.tsx')).sort();
  const pdfTooling=inspectPdfToolScope(cwd);
  const units = buildUnits(suite,groups,browsers);
  const sourceFiles=new Map(units.filter(unit=>unit.singleton).map(unit=>[unit.id,singletonSources(unit,cwd)]));
  const historicalArchives=new Set(['test/fixtures/historical-migrations/2301_attendance_workflow_submission_shared_lock.sql','test/fixtures/historical-migrations/3103_access_editor_presentation.sql']);
  const requiredMigrations=new Set(units.filter(unit=>unit.singleton&&unit.kind==='db').flatMap(unit=>sourceFiles.get(unit.id))
   .filter(file=>file==='db/migrations/meta/_journal.json'||file.startsWith('db/migrations/')&&file.endsWith('.sql')||historicalArchives.has(file)));
  if(requiredMigrations.size){
   // The existing clean-HEAD owner observes the index ONCE. Clean status alone
   // does not exclude ignored SQL; journal-derived membership is not tracking.
   const raw=git('ls-files','--cached','--stage','-z','--','db/migrations',...historicalArchives);
   if(!raw.endsWith('\0'))throw Error('Incomplete canonical migration index');
   const index=new Map();
   for(const record of raw.slice(0,-1).split('\0')){
    const match=/^([0-7]{6}) ([a-f0-9]{40}) 0\t([^\0]+)(?![\s\S])/.exec(record);
    if(!match)throw Error('Malformed canonical migration index');
    const [,mode,,file]=match;
    if(!(file.startsWith('db/migrations/')||historicalArchives.has(file))||file.includes('\\')||/[\x00-\x1f\x7f]/.test(file)
      ||file.split('/').some(part=>part===''||part==='.'||part==='..')||index.has(file))throw Error('Noncanonical or duplicate migration index path');
    index.set(file,mode);
   }
   for(const file of requiredMigrations)if(!['100644','100755'].includes(index.get(file)))throw Error('Canonical database source must be tracked as a regular file: '+file);
  }
  for(const unit of units)if(employeeLifecycleUnit(unit))assertEmployeeLifecycleSourceClosure(sourceFiles.get(unit.id),JSON.parse(readFileSync(resolve(cwd,'db/migrations/meta/_journal.json'),'utf8')));
  const singletonSourceHashes=Object.fromEntries(units.filter(u=>u.singleton).map(unit=>[unit.id,Object.fromEntries(sourceFiles.get(unit.id).map(file=>{
   const path=resolve(cwd,file);if(realpathSync(path)!==path||!lstatSync(path).isFile()||lstatSync(path).size>singletonSourceMaximum(file))throw Error('Unsafe singleton source');
   return [file,createHash('sha256').update(readFileSync(path)).digest('hex')];
  }))]));
  const body = {schemaVersion: 2, policyVersion: CI_POLICY, sha, controller: process.env.AIHR_CI_CONTROL_HEAD ?? 'local', migrationBase: process.env.AIHR_CI_MIGRATION_BASE ?? null, runtime:{node:process.versions.node,platform:process.platform,arch:process.arch}, execution:CI_EXECUTION, pdfTooling, singletonSources:singletonSourceHashes, suite, units};
  return {...body, fingerprint: hash(body)};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(createPlan(), null, 2));
