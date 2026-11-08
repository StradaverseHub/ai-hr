/** Infrastructure annotations never remove files or grant release authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {CI_POLICY} from './policy-version.mjs';
import {NATIVE_HELPER_SOURCES} from './native-next-helper-sources.mjs';
export const SINGLETON_VERSION=1;
const measured=[
 'test/analytics-termination-lateral.test.ts',
 'test/employee-choice-assignment-membership-plan.test.ts',
 'test/employee-choice-organisation-plan.test.ts',
 'test/leave-inquiry-read-cost.test.ts',
 'test/payroll-audit-processing-rc.test.ts',
 'test/performance/attendance-punch-index.profile.test.ts',
 'test/performance/claims-preview-index.profile.test.ts',
 'test/performance/leave-pending-index.profile.test.ts',
 'test/performance/personnel-narrow-overview.test.ts',
 'test/performance/personnel-narrow-production.test.ts',
 'test/performance/personnel-native-list-plan.test.ts',
 'test/performance/personnel-retained-million.test.ts',
 'test/performance/workforce-bounded-read-plan.test.ts',
];
export const SINGLETON_FILES=Object.freeze({
 ...Object.fromEntries(measured.map(file=>[file,'controlled-database-v1'])),
 'test/runtime-ready-admission-native.test.ts':'linux-systemd-nginx-v1',
 'test/runtime-next-host-view-native.test.ts':'linux-systemd-nginx-v1',
 'test/notification-worker-lifecycle.test.ts':'notification-cluster-v1',
 'test/runtime-next-admission-native.test.ts':'linux-next-postgres-v1',
});
export const singletonProfile=file=>Object.hasOwn(SINGLETON_FILES,file)?SINGLETON_FILES[file]:null;
export const nativeNextUnit=unit=>unit?.singleton?.profile==='linux-next-postgres-v1';
export const singletonControllerPath=(unit,workspace,runId)=>nativeNextUnit(unit)?'/var/lib/aihr-native-controller/'+runId+'/automation':workspace+'/automation';
export const singletonJobName=unit=>nativeNextUnit(unit)?`native-test (${unit.id})`:unit.kind==='browser'?`browser (${unit.engine})`:`test (${unit.id})`;
export const singletonKind=profile=>profile==='linux-systemd-nginx-v1'?'nodb':'db';
export function assertSingletonSelection(files){assert(!files.some(file=>singletonProfile(file))||files.length===1,'Infrastructure-sensitive focused tests require an actual sole-file selection');}
export function assertSingletonCoverage(suite,read){
 for(const file of suite){
  const text=read(file),profile=singletonProfile(file);
  const focusedGuard=/AIHR_FOCUSED_(?:TESTS|SUITE_CAPACITY|EVIDENCE_DIR)/.test(text)&&/\.(?:skipIf|runIf)\s*\(/.test(text);
  assert(!focusedGuard,'Focused-only conditional cases require registered full-CI singleton admission: '+file);
  if(profile)assert(/\badmitSingletonTest\s*\(/.test(text),'Registered singleton lacks actual full/focused admission: '+file);
 }
}
export const singletonDescriptor=file=>{const profile=singletonProfile(file);return profile?{version:SINGLETON_VERSION,profile,workers:1,isolation:profile==='linux-next-postgres-v1'?'job-host-and-postgres-cluster':profile==='linux-systemd-nginx-v1'?'job-host':'job-postgres-cluster'}:null;};
export function assertSingletonUnit(unit){
 assert(unit&&unit.files?.length===1,'Singleton unit requires exactly one complete test file');
 const expected=singletonDescriptor(unit.files[0]);assert(expected,'Unregistered singleton file');
 assert.deepEqual(unit.singleton,expected,'Changed singleton execution profile');assert.equal(unit.kind,singletonKind(expected.profile));
 return expected;
}
export function singletonSources(unit){
 assertSingletonUnit(unit);
 return [unit.files[0],'test/helpers/ci-singleton-admission.ts','.github/ci/singleton-protocol.mjs','.github/ci/policy-version.mjs',
  'vitest.config.ts','vitest.nodb.config.ts',...(unit.kind==='db'?['test/db-names.ts','test/global-setup.ts','test/env.ts']:['deploy/admission/test_native.py']),
  ...(unit.files[0]==='test/runtime-next-host-view-native.test.ts'?[
   'deploy/admission/test_next_host_view_native.py','deploy/admission/test_next_native.py','deploy/admission/next_profile.py','.github/ci/runtime_inventory.py',
   '.github/ci/singleton-profiles.mjs','.github/ci/run-unit.mjs','.github/ci/plan.mjs','.github/ci/manifest.mjs',
   '.github/ci/candidate-environment.mjs','.github/actions/setup-alpha/action.yml','.github/workflows/alpha-staging.yml',
   'scripts/gate-db-classify.ts']:[]),
  ...(nativeNextUnit(unit)?[...Object.values(NATIVE_HELPER_SOURCES),'.github/ci/native-next-helper-sources.mjs','.github/ci/native-next-build-packet.mjs',
   '.github/ci/native-next-installation.mjs','.github/ci/native-next-build-inputs.mjs','.github/ci/candidate-environment.mjs','.github/ci/build-artifact.mjs',
   'test/helpers/native-next-fixture.ts','scripts/performance/native-next-boot-browser.mjs',
   'scripts/performance/fixture-workload.mjs','scripts/performance/next-source-proof.mjs',
   '.github/ci/native-controller-bootstrap.py','.github/ci/native-controller-owner.mjs','.github/ci/prepare-runner.sh',
   '.github/ci/run-unit.mjs','.github/ci/plan.mjs','.github/ci/singleton-profiles.mjs',
   '.github/actions/setup-alpha/action.yml','.github/workflows/alpha-staging.yml',
   'scripts/migrate-with-focused-prerequisites.ts','scripts/lib/discard-premigration.ts','test/helpers/personnel-draft-discard-ci-role-fixture.ts']:[])].sort();
}
export const protocolHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fullSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value);
export function assertNoSingletonHints(env){assert(!Object.keys(env).some(key=>key.startsWith('AIHR_CI_SINGLETON_')),'Inherited singleton admission hints are forbidden');}
export function validateSingletonDatabaseUrls(env,database){
 for(const [key,user]of Object.entries({DATABASE_URL:'ai_hr_app',TEST_DATABASE_URL:'ai_hr_app',MIGRATION_DATABASE_URL:'postgres',TEST_MIGRATION_DATABASE_URL:'postgres'})){
  const value=new URL(env[key]);assert(['postgres:','postgresql:'].includes(value.protocol));assert.equal(value.hostname,'127.0.0.1');assert.equal(value.port,'5433');assert.equal(value.pathname,'/'+database);assert.equal(value.username,user);assert.equal(value.search,'');assert.equal(value.hash,'');
 }
}
export function validateNativeHostPrerequisite(p){
 assert(p&&Object.keys(p).sort().join('|')==='kind|nginxPath|nginxSha256|nginxVersion|pid1|platform|sudoUid|systemdVersion');
 assert.equal(p.kind,'actual-job-systemd-nginx');assert.equal(p.platform,'linux');assert.equal(p.pid1,'systemd');assert.equal(p.sudoUid,'0');
 assert.equal(p.nginxPath,'/usr/sbin/nginx');assert(digest(p.nginxSha256));assert(/^nginx version: nginx\//.test(p.nginxVersion));assert(/^systemd [0-9]+/.test(p.systemdVersion));
}
/** Metadata structure only. The provisioning owner authenticates actual GitHub
 * producer/job/artifact bytes before issuing this conjunction; callers cannot
 * turn a host-only or DB-only receipt into the hybrid execution capability. */
export function validateNativeBuildPrerequisite(p,expected){
 assert(p&&Object.keys(p).sort().join('|')==='archiveSha256|artifactDigest|artifactId|attempt|controller|kind|manifestSha256|nextBuildId|producerJobId|provenanceSha256|runId|source');
 assert.equal(p.kind,'same-run-canonical-next-build');
 for(const key of ['source','controller'])assert.equal(p[key],expected[key]);
 assert.equal(p.runId,String(expected.runId));assert.equal(p.attempt,String(expected.attempt));assert.equal(p.attempt,'1');
 for(const key of ['artifactId','producerJobId'])assert(positive(p[key]));
 for(const key of ['archiveSha256','manifestSha256','provenanceSha256'])assert(digest(p[key]));
 assert(/^sha256:[a-f0-9]{64}$/.test(p.artifactDigest));assert(/^[A-Za-z0-9_-]{1,512}$/.test(p.nextBuildId));
}
export function validateSingletonBinding(binding,plan,unit,witness){
 const descriptor=assertSingletonUnit(unit);
 assert(binding&&Object.keys(binding).sort().join('|')===['schemaVersion','mode','candidate','controller','runId','attempt','unit','fingerprint','file','profile','sourceHashes','evidenceDirectory','prerequisites'].sort().join('|'),'Closed singleton binding required');
 assert.equal(binding.schemaVersion,1);assert.equal(binding.mode,'full-ci-singleton');
 assert.equal(plan.policyVersion,CI_POLICY);
 const {fingerprint,...body}=plan;assert.equal(protocolHash(body),fingerprint,'Actual complete plan fingerprint differs');
 assert(fullSha(plan.sha)&&fullSha(plan.controller)&&digest(plan.fingerprint));
 assert.equal(binding.candidate,plan.sha);assert.equal(binding.controller,plan.controller);assert.equal(binding.fingerprint,plan.fingerprint);
 assert.equal(binding.unit,unit.id);assert.equal(binding.file,unit.files[0]);assert.equal(binding.profile,descriptor.profile);
 assert(witness&&positive(String(witness.runId))&&String(witness.attempt)==='1','Authenticated first-attempt full-CI context required');
 assert.equal(binding.runId,String(witness.runId));assert.equal(binding.attempt,'1');
 assert.deepEqual(binding.sourceHashes,plan.singletonSources?.[unit.id],'Singleton source binding differs');
 assert.deepEqual(Object.keys(binding.sourceHashes??{}).sort(),singletonSources(unit));
 for(const value of Object.values(binding.sourceHashes))assert(digest(value),'Invalid singleton source hash');
 assert(typeof binding.evidenceDirectory==='string'&&binding.evidenceDirectory.startsWith('/')&&!binding.evidenceDirectory.includes('\0'));
 const p=binding.prerequisites;
 if(unit.kind==='db'){
  assert(p&&Object.keys(p).sort().join('|')===(nativeNextUnit(unit)?'build|database|host|kind|workers':'database|kind|workers'));
  assert.equal(p.kind,nativeNextUnit(unit)?'fresh-job-next-systemd-nginx-postgres':'fresh-job-postgres-cluster');assert.equal(p.workers,1);
  assert.equal(p.database?.name,`aihr-ci-${binding.runId}-${binding.attempt}-${unit.id}`,'Cluster belongs to another job unit');
  validatePostgresEvidence(p.database,plan.execution);
  if(nativeNextUnit(unit)){
   validateNativeHostPrerequisite(p.host);
   validateNativeBuildPrerequisite(p.build,{source:plan.sha,controller:plan.controller,runId:binding.runId,attempt:binding.attempt});
  }
 }else validateNativeHostPrerequisite(p);
 return true;
}
/** Environment is admission context, not API authentication. The release verifier
 * separately authenticates workflow/job/artifact provenance against GitHub. */
export function validateSingletonHost({env,event,layout,plan,unit}){
 assertSingletonUnit(unit);
 assert.equal(plan.units.filter(row=>row.id===unit.id).length,1);assert.deepEqual(plan.units.find(row=>row.id===unit.id),unit);
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_WORKFLOW:'alpha-staging-ci',GITHUB_JOB:nativeNextUnit(unit)?'native-test':'test',GITHUB_RUN_ATTEMPT:'1'}))assert.equal(env[key],value,key);
 assert(positive(env.GITHUB_RUN_ID));assert.equal(env.AIHR_CI_HEAD,plan.sha);assert.equal(env.AIHR_CI_CONTROL_HEAD,plan.controller);assert.equal(env.GITHUB_SHA,plan.controller);
 assert.equal(layout.platform,'linux');assert.equal(layout.sourceHead,plan.sha);assert.equal(layout.controllerHead,plan.controller);assert.equal(layout.sourceClean,true);assert.equal(layout.controllerClean,true);
 assert.equal(layout.source,layout.workspace+'/source');assert.equal(layout.automation,singletonControllerPath(unit,layout.workspace,env.GITHUB_RUN_ID));assert.equal(layout.cwd,layout.source);assert.equal(layout.evidence,layout.temp+'/aihr-ci');
 assert(!Object.keys(env).some(key=>key.startsWith('AIHR_FOCUSED_')),'Focused and full singleton intent cannot mix');
 assert(env.TEST_DB_NAMESPACE===undefined||env.TEST_DB_NAMESPACE==='');
 assert.equal(event?.repository?.full_name,'StradaverseHub/ai-hr');assert.equal(String(event.repository.id),'1333414856');
 const prefix='StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@';assert(env.GITHUB_WORKFLOW_REF?.startsWith(prefix));const ref=env.GITHUB_WORKFLOW_REF.slice(prefix.length);
 if(env.GITHUB_EVENT_NAME==='workflow_dispatch'){assert(/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref));if(event.inputs?.expected_sha)assert.equal(event.inputs.expected_sha,plan.sha);}
 else if(env.GITHUB_EVENT_NAME==='push'){assert.equal(ref,'refs/heads/alpha');assert.equal(event.ref,ref);assert.equal(event.after,plan.sha);assert.equal(plan.sha,plan.controller);}
 else if(env.GITHUB_EVENT_NAME==='pull_request'){const pr=event.pull_request;assert(pr&&pr.draft===false);assert.equal(pr.base?.ref,'alpha');assert.equal(pr.head?.repo?.full_name,'StradaverseHub/ai-hr');assert.equal(String(pr.head.repo.id),'1333414856');assert.equal(pr.head.sha,plan.sha);assert.equal(pr.merge_commit_sha,plan.controller);assert(positive(String(event.number)));assert.equal(ref,`refs/pull/${event.number}/merge`);}
 else assert.fail('Unsupported full-CI singleton event');
}

/** Independently authenticated release bytes must match the build actually
 * exercised by every native Next unit. Source equality alone is insufficient. */
export function assertNativeBuildMatches(plan,reports,packet,artifact,producerJobId){
 const units=plan.units.filter(nativeNextUnit);if(!units.length)return true;
 assert.equal(packet.kind,'AUTHENTICATED_CI_BUILD_PACKET_NOT_DEPLOYMENT');assert.equal(packet.canonicalCandidateInputsVerified,true);
 assert.equal(packet.source,plan.sha);assert.equal(packet.controller,plan.controller);
 assert.equal(artifact?.name,'production-build-v1');assert(positive(String(artifact.id))&&positive(String(producerJobId)));
 for(const unit of units){
  const matches=reports.filter(report=>report?.id===unit.id);assert.equal(matches.length,1,'Missing exact native build unit report');
  const p=matches[0].singleton?.prerequisites?.build;
  validateNativeBuildPrerequisite(p,{source:plan.sha,controller:plan.controller,runId:String(packet.runId),attempt:'1'});
  assert.equal(p.artifactId,String(artifact.id));assert.equal(p.artifactDigest,artifact.digest);assert.equal(p.producerJobId,String(producerJobId));
  for(const key of ['nextBuildId','archiveSha256','manifestSha256','provenanceSha256'])assert.equal(p[key],packet[key],'Native tests exercised another compiled build: '+key);
 }
 return true;
}
