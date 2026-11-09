/** Private two-checkout witness. This file never provisions, migrates, resets, or drops a database. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionContext } from '../db/client';
import type { Base } from '../test/harness';
import {APP_URL, BASE, CANDIDATE, OWNER_URL, readCanonicalAdmission} from './fictional-ai-upgrade-canonical-admission.mjs';

const BASE_MODULE = '7f15e132bb44c257e9a9615184e12625684556945f8edc9b75999657c3266d2e';
const CANDIDATE_MODULE = '9e45abb74a6035bd26d9eaef8fe2e06bc0a88de2704587ef1864a378b5c465a9';
const BASE_PROVIDER = '020279efedc544846db0bcc91e6fba27b8c49725169178fa8307c1bc8b6b394c';
const CANDIDATE_PROVIDER = '51789bac0824dc0a33acee0dc0b3887f61bc94e40c67a5093f45fe0b5c91c432';
const AI_TABLES = ['ai_agent_candidate', 'ai_agent_candidate_provenance', 'ai_agent_evaluation',
  'ai_agent_promotion', 'ai_agent_job_receipt', 'ai_agent_job_feedback', 'ai_agent_rollback'] as const;
const TABLES = [...AI_TABLES, 'assistant_grant', 'person', 'employment', 'assignment', 'reporting_line', 'role_assignment', 'domain_event'] as const;
type RowHashes = Record<string, string[]>;
type LedgerRow = { id: string; hash: string; created_at: string };
type Login = { userId: string; personId: string };
type Before = {
  baseline: string; candidate: string; script: string; database: string; base: Base;
  controller: string; runId: string; containerId: string; postgresSystemId: string; postmasterEpoch: string;
  executionUid: number; netNamespace: string;
  prerequisiteSha256: string;
  author: Login; reviewer: Login; secondReviewer: Login; promoter: Login; outsider: Login; employmentId: string;
  candidateId: string; promotionId: string; jobId: string; feedbackId: string; nonce: string;
  facts: string; rows: RowHashes; ledger: LedgerRow[];
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks','-c','core.fsmonitor=false',
  '-c','core.hooksPath=/dev/null','-c','safe.directory='+process.cwd(),...args],
  {encoding:'utf8',timeout:15_000,maxBuffer:4*1024**2}).trim();
const phase = process.argv[2];
assert(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && process.env.NODE_ENV === 'test', 'Hosted fictional owner required');
assert(process.argv.length === 3 && (phase === 'prepare' || phase === 'compare'), 'Choose prepare or compare');
const env = process.env;
const privateDirectory = env.AIHR_AI_UPGRADE_ARTIFACT_DIR ?? '';
const runner = env.RUNNER_TEMP ?? '';
assert(isAbsolute(runner) && isAbsolute(privateDirectory) && realpathSync(privateDirectory) === privateDirectory
  && privateDirectory.startsWith(realpathSync(runner) + '/'), 'Use an owned runner temp directory');
const directoryStat = lstatSync(privateDirectory);
assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && (directoryStat.mode & 0o077) === 0
  && directoryStat.uid === process.getuid?.(), 'Private fixture directory permissions required');
assert(!env.DATABASE_URL && !env.MIGRATION_DATABASE_URL && !env.AI_CONFIG_SECRET, 'Supply only the fixture connections and a clean environment');
for (const key of Object.keys(env)) {
  assert(!/^(OPENAI_|ANTHROPIC_|GOOGLE_API_KEY$|GOOGLE_AI_|GEMINI_|OPENROUTER_|AI_GATEWAY_|AI_DRAFT_|https?_proxy$|all_proxy$)/i.test(key), 'Provider and proxy settings are forbidden');
}
const expectedCommit = phase === 'prepare' ? BASE : CANDIDATE;
assert(git('rev-parse','HEAD') === expectedCommit && git('status','--porcelain','--untracked-files=no') === ''
  && realpathSync(process.cwd()) === git('rev-parse','--show-toplevel'), 'Exact clean source checkout required');
const script = hash(readFileSync(fileURLToPath(import.meta.url)));
const custody = readCanonicalAdmission({env,phase,uid:process.getuid?.(),platform:process.platform,source:expectedCommit,witnessSha256:script});
assert.equal(readlinkSync('/proc/self/ns/net'),custody.host.netNamespace);
const beforePath = join(privateDirectory,'before.json'), afterPath = join(privateDirectory,'after.json');
const keyPath = join(privateDirectory,'receipt-key');
assert(!existsSync(afterPath) && (phase === 'prepare' ? !existsSync(beforePath) && !existsSync(keyPath) : existsSync(beforePath)), 'Preserve existing or incomplete evidence');
const privateRead = (path: string) => {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0
    && stat.uid === process.getuid?.() && stat.size <= 1024**2, 'Private bounded fixture artifact required');
  return readFileSync(path,'utf8');
};
const privateWrite = (path: string, text: string) => writeFileSync(path,text,{mode:0o600,flag:'wx'});
env.DATABASE_URL = APP_URL;
env.MIGRATION_DATABASE_URL = OWNER_URL;

async function main() {
  const {expectedMigrationLedger, validateMigrationLedgerRows} = await import('../.github/ci/staging-migration-ledger.mjs');
  const {MODULE_AGENT_SOURCE_DIGEST} = await import('../lib/ai/module-agent-source-manifest');
  const {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} = await import('../lib/ai/provider-data-source-manifest');
  assert.equal(MODULE_AGENT_SOURCE_DIGEST, phase === 'prepare' ? BASE_MODULE : CANDIDATE_MODULE);
  assert.equal(PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST, phase === 'prepare' ? BASE_PROVIDER : CANDIDATE_PROVIDER);
  const {owner, closeAll, createAppUser, entitledCtx, seedBase, setModule} = await import('../test/harness');
  try {
    // Fresh fictional replay uses the current source SQL bytes, including the two migrations
    // whose original staging-applied bytes are historically pinned separately.
    const freshLedger = expectedMigrationLedger(process.cwd()).map(({tag, created_at, hash, sourceSha256}) => ({
      tag, created_at, hash:sourceSha256 ?? hash,
    }));
    const ledger = [...await owner.client<LedgerRow[]>`select id::text as id, hash, created_at::text as created_at
      from drizzle.__drizzle_migrations order by id`];
    assert.equal(freshLedger.length, phase === 'prepare' ? 723 : 764);
    validateMigrationLedgerRows(freshLedger,ledger);
    const [{db,role,postgresSystemId,postmasterEpoch}] = await owner.client<{
      db:string;role:string;postgresSystemId:string;postmasterEpoch:string;
    }[]>`select current_database() as db,session_user as role,c.system_identifier::text as "postgresSystemId",
      extract(epoch from pg_postmaster_start_time())::text as "postmasterEpoch" from pg_control_system() c`;
    assert.equal(db,'ai_hr_dev');
    assert.equal(role,'postgres');
    assert.equal(postgresSystemId,custody.host.postgresSystemId);
    assert.equal(postmasterEpoch,custody.host.postmasterEpoch);

    const before: Before | null = phase === 'compare' ? JSON.parse(privateRead(beforePath)) : null;
    if (before) {
      assert.equal(before.baseline,BASE); assert.equal(before.candidate,CANDIDATE); assert.equal(before.script,script);
      assert.equal(before.database,db);
      assert.equal(before.controller,custody.controller); assert.equal(before.runId,custody.runId);
      assert.equal(before.containerId,custody.host.containerId); assert.equal(before.postgresSystemId,postgresSystemId);
      assert.equal(before.postmasterEpoch,postmasterEpoch);
      assert.equal(before.executionUid,custody.host.uid); assert.equal(before.netNamespace,custody.host.netNamespace);
      assert(before.prerequisiteSha256 !== custody.prerequisiteSha256,'A fresh candidate prerequisite receipt is required');
      assert.equal(before.ledger.length,723);
      assert.deepEqual(ledger.slice(0,723),before.ledger);
    } else {
      const [{count}] = await owner.client<{count: number}[]>`select count(*)::int as count from public.tenant`;
      assert.equal(count,0,'Start with a schema-only fictional baseline');
      privateWrite(keyPath,randomBytes(32).toString('hex'));
    }
    env.AI_CONFIG_SECRET = privateRead(keyPath);
    assert.match(env.AI_CONFIG_SECRET,/^[a-f0-9]{64}$/);

    const {sql} = await import('drizzle-orm');
    const {withTenant} = await import('../db/client');
    const {todayInKualaLumpur} = await import('../lib/hr-date');
    const {hireEmployee} = await import('../core/org');
    const {setReportingLine} = await import('../core/workforce-commands');
    const {grantAssistant,mayUseAssistant} = await import('../core/assistant-grant');
    const {reportingLinesFor} = await import('../core/read');
    const {loadGovernedWorkspaceJobTx} = await import('../core/workspace-module-jobs');
    const releases = await import('../core/module-agent-releases');
    const ctx = async (base: Base, login: Login, role:'hr_admin'|'employee'='hr_admin'): Promise<SessionContext> => ({
      ...await entitledCtx(base), ...login, roles:[role], grants:[{role,companyId:null}],
    });
    const reopen = (who: SessionContext, id: string) => withTenant(who, async tx => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return loadGovernedWorkspaceJobTx(who,tx,id);
    });
    const readHashes = async (tenantId: string): Promise<RowHashes> => Object.fromEntries(await Promise.all(TABLES.map(async table => {
      const rows = await owner.client.unsafe<{row:string}[]>(
        `select to_jsonb(t)::text as row from public."${table}" t where tenant_id=$1::uuid order by 1`,[tenantId],
      );
      return [table,rows.map(row=>hash(row.row)).sort()];
    })));
    const facts = async (who: SessionContext, employmentId: string) => {
      const native = await reportingLinesFor(who,employmentId);
      const projection = native.managers.map(({lineType,name,employeeCode}) => ({lineType,name,employeeCode}));
      assert(projection.some(row=>row.lineType==='functional'),'Nonempty native control required');
      return {projection,digest:hash(JSON.stringify(projection))};
    };

    if (!before) {
      const base = await seedBase();
      await setModule(base.tenantId,'assistant','active');
      const root: SessionContext = {...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]};
      const actor = async (name: string, role:'hr_admin'|'employee'='hr_admin') => {
        const hired = await hireEmployee(root,{person:{fullName:'Fictional AI upgrade '+name,primaryEmail:randomUUID()+'@fixture.test'},
          companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
        const userId = await createAppUser(base.tenantId,hired.personId,role);
        await grantAssistant(root,{appUserId:userId});
        return {login:{userId,personId:hired.personId},employmentId:hired.employmentId};
      };
      // Keep fixture writes in the same order as the existing lifecycle fixture.
      const authorActor = await actor('Author'), reviewerActor = await actor('Reviewer A'),
        secondActor = await actor('Reviewer B'), promoterActor = await actor('Promoter'), managerActor = await actor('Manager'),
        outsiderActor = await actor('Outsider','employee');
      for (const entry of [authorActor,reviewerActor,secondActor]) {
        await setReportingLine(root,{subordinateEmploymentId:entry.employmentId,managerEmploymentId:managerActor.employmentId,
          lineType:'functional',validFrom:todayInKualaLumpur()});
      }
      const authorCtx = await ctx(base,authorActor.login);
      const {candidateId} = await releases.createCanonicalSpecialistCandidate(authorCtx,{module:'org',version:1,playbook:'canonical_followup_v1'});
      for (const reviewer of [reviewerActor,secondActor]) {
        const evaluation = await releases.evaluateCanonicalSpecialistCandidate(await ctx(base,reviewer.login),candidateId);
        assert.equal(evaluation.state,'complete');
        assert.equal(evaluation.nativeEvidence,'present');
        assert.equal(evaluation.securityFailures,0);
        assert.equal(evaluation.qualityFailures,0);
      }
      const {promotionId} = await releases.promoteCanonicalSpecialistCandidate(await ctx(base,promoterActor.login),{candidateId,maxJobs:3,hours:1});
      const nonce = randomUUID(), job = await releases.runGovernedSpecialistJob(authorCtx,{module:'org'},{nonce});
      assert.equal(job.mode,'promoted');
      assert.equal(job.specialist?.diagnostic?.code,'review_reporting');
      const {feedbackId} = await releases.recordOwnGovernedJobFeedback(authorCtx,{jobId:job.jobId,outcome:'helpful',consented:true});
      const card = await reopen(authorCtx,job.jobId);
      assert(card.state === 'ready' && card.mode === 'promoted' && card.feedbackOutcome === 'helpful');
      const rows = await readHashes(base.tenantId);
      for (const table of TABLES) if (table !== 'ai_agent_rollback') assert(rows[table].length > 0,'Expected populated '+table);
      assert.equal(rows.ai_agent_rollback.length,0);
      const saved: Before = {baseline:BASE,candidate:CANDIDATE,script,database:db,base,
        controller:custody.controller,runId:custody.runId,containerId:custody.host.containerId,postgresSystemId,postmasterEpoch,
        executionUid:custody.host.uid,netNamespace:custody.host.netNamespace,prerequisiteSha256:custody.prerequisiteSha256,
        author:authorActor.login,reviewer:reviewerActor.login,secondReviewer:secondActor.login,promoter:promoterActor.login,
        outsider:outsiderActor.login,employmentId:authorActor.employmentId,
        candidateId,promotionId,jobId:job.jobId,feedbackId,nonce,facts:(await facts(authorCtx,authorActor.employmentId)).digest,rows,ledger};
      privateWrite(beforePath,JSON.stringify(saved,null,2)+'\n');
      process.stdout.write(JSON.stringify({status:'PREPARED',baseline:BASE,ledger:ledger.length,releaseAuthorized:false})+'\n');
      return;
    }

    const author = await ctx(before.base,before.author), reviewer = await ctx(before.base,before.reviewer);
    const secondReviewer = await ctx(before.base,before.secondReviewer), promoter = await ctx(before.base,before.promoter);
    const outsider = await ctx(before.base,before.outsider,'employee');
    assert.equal((await mayUseAssistant(outsider)).allowed,true,'Outsider must hold an actual Assistant grant');
    const retained = await readHashes(before.base.tenantId);
    assert.deepEqual(retained,before.rows,'Migration must retain complete original rows');
    const native = await facts(author,before.employmentId);
    assert.equal(native.digest,before.facts,'Retained native reporting facts differ');
    const used = async (promotionId:string) => {
      const [{used}] = await owner.client<{used:number}[]>`select used_jobs::int as used from public.ai_agent_promotion
        where id=${promotionId}::uuid and tenant_id=${before.base.tenantId}::uuid`;
      return used;
    };
    assert.equal(await used(before.promotionId),1);
    const review = await withTenant(reviewer,tx=>releases.specialistReviewWorkspaceTx(tx,reviewer));
    const prior = review?.candidates.find(row=>row.id===before.candidateId);
    assert(prior && prior.passingEvaluators === null,'Historical candidate must remain visible without current progress');
    assert(review?.promotions.some(row=>row.id===before.promotionId),'Historical promotion is missing');
    assert.deepEqual(await reopen(author,before.jobId),{state:'unavailable'});
    assert.deepEqual(await reopen(reviewer,before.jobId),{state:'unavailable'});
    assert.deepEqual(await reopen(outsider,before.jobId),{state:'unavailable'});
    await assert.rejects(releases.evaluateCanonicalSpecialistCandidate(reviewer,before.candidateId));
    await assert.rejects(releases.promoteCanonicalSpecialistCandidate(promoter,{candidateId:before.candidateId,maxJobs:3,hours:1}));
    await assert.rejects(releases.runGovernedSpecialistJob(author,{module:'org'},{nonce:before.nonce}));
    await assert.rejects(releases.recordOwnGovernedJobFeedback(author,{jobId:before.jobId,outcome:'helpful',consented:true}));
    assert.deepEqual(await readHashes(before.base.tenantId),retained,'History inspection and refused commands must be read-only');

    const job = await releases.runGovernedSpecialistJob(author,{module:'org'},{nonce:randomUUID()});
    assert.equal(job.mode,'baseline');
    assert.equal(job.specialist?.coverage,'canonical_domain_guidance_only');
    assert.deepEqual(job.effects,[]);
    assert.equal(job.results.length,1);
    const result = job.results[0].data as {rows:{employmentId:string;reportingLines:unknown[]}[]};
    assert.deepEqual(result.rows.map(row=>row.employmentId),[before.employmentId]);
    assert.deepEqual(result.rows[0].reportingLines,native.projection);
    const card = await reopen(author,job.jobId);
    assert(card.state === 'ready' && card.mode === 'baseline','Current grounded card must be available');
    assert.deepEqual(await reopen(reviewer,job.jobId),{state:'unavailable'});
    assert.equal(await used(before.promotionId),1);
    const rollbacks = [...await owner.client<{reason:string}[]>`select reason from public.ai_agent_rollback
      where tenant_id=${before.base.tenantId}::uuid and promotion_id=${before.promotionId}::uuid`];
    assert.deepEqual(rollbacks,[{reason:'source_changed'}]);
    const afterBaseline = await readHashes(before.base.tenantId);
    for (const table of TABLES) {
      if (table === 'ai_agent_job_receipt') assert.equal(afterBaseline[table].length,retained[table].length+1);
      else if (table === 'ai_agent_rollback') assert.equal(afterBaseline[table].length,1);
      else assert.deepEqual(afterBaseline[table],retained[table],'Unexpected change in '+table);
    }
    assert(retained.ai_agent_job_receipt.every(row=>afterBaseline.ai_agent_job_receipt.includes(row)),'Original job receipt bytes changed');

    const {candidateId:currentCandidate} = await releases.createCanonicalSpecialistCandidate(author,
      {module:'org',version:2,playbook:'canonical_followup_v1'});
    const promoteCurrent = (actor:SessionContext) => releases.promoteCanonicalSpecialistCandidate(actor,
      {candidateId:currentCandidate,maxJobs:3,hours:1});
    const afterCandidate = await readHashes(before.base.tenantId);
    await assert.rejects(releases.evaluateCanonicalSpecialistCandidate(author,currentCandidate));
    await assert.rejects(releases.evaluateCanonicalSpecialistCandidate(outsider,currentCandidate));
    await assert.rejects(promoteCurrent(outsider));
    assert.deepEqual(await readHashes(before.base.tenantId),afterCandidate,'Unauthorized decisions must not write');
    for (const independent of [reviewer,secondReviewer]) {
      const evaluation = await releases.evaluateCanonicalSpecialistCandidate(independent,currentCandidate);
      assert.equal(evaluation.state,'complete');
      assert.equal(evaluation.nativeEvidence,'present');
      assert.equal(evaluation.securityFailures,0);
      assert.equal(evaluation.qualityFailures,0);
    }
    const evaluated = await readHashes(before.base.tenantId);
    await assert.rejects(promoteCurrent(author));
    await assert.rejects(promoteCurrent(reviewer));
    assert.deepEqual(await readHashes(before.base.tenantId),evaluated,'Non-independent decisions must not write');
    const {promotionId:currentPromotion} = await promoteCurrent(promoter);
    assert.equal(await used(currentPromotion),0);
    const promotionView = await withTenant(reviewer,tx=>releases.specialistReviewWorkspaceTx(tx,reviewer));
    assert(promotionView?.promotions.some(row=>row.id===currentPromotion&&!row.retired));
    assert(promotionView?.promotions.some(row=>row.id===before.promotionId&&row.retired));
    const currentJob = await releases.runGovernedSpecialistJob(author,{module:'org'},{nonce:randomUUID()});
    assert.equal(currentJob.mode,'promoted');
    assert.equal(currentJob.specialist?.diagnostic?.code,'review_reporting');
    assert.deepEqual(currentJob.effects,[]);
    assert.deepEqual(currentJob.results,job.results);
    const currentCard = await reopen(author,currentJob.jobId);
    assert(currentCard.state==='ready'&&currentCard.mode==='promoted');
    assert.deepEqual(await reopen(outsider,currentJob.jobId),{state:'unavailable'});
    assert.equal(await used(currentPromotion),1);
    assert.equal(await used(before.promotionId),1);
    const after = await readHashes(before.base.tenantId);
    const added:Record<string,number> = {ai_agent_candidate:1,ai_agent_candidate_provenance:1,ai_agent_evaluation:2,
      ai_agent_promotion:1,ai_agent_job_receipt:1};
    for (const table of TABLES) {
      assert.equal(after[table].length,afterBaseline[table].length+(added[table]??0),'Unexpected row count in '+table);
      assert(afterBaseline[table].every(row=>after[table].includes(row)),'Retained row bytes changed in '+table);
    }
    const report = {status:'PASS',baseline:BASE,candidate:CANDIDATE,controller:custody.controller,runId:custody.runId,
      attempt:1,retainedTables:TABLES.length,ledgerBefore:before.ledger.length,ledgerAfter:ledger.length,
      oldReplay:'unavailable',fallbackReplay:'baseline',currentReplay:'promoted',oldPermitsUsed:1,currentPermitsUsed:1,
      sourceChangedRollbacks:1,releaseAuthorized:false};
    privateWrite(afterPath,JSON.stringify(report,null,2)+'\n');
    process.stdout.write(JSON.stringify(report)+'\n');
  } finally { await closeAll(); }
}
void main().catch(() => {
  process.stderr.write('Fictional AI source upgrade witness failed. Preserve the isolated database and private evidence for investigation.\n');
  process.exitCode = 1;
});
