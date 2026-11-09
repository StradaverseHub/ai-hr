/** Sole fresh-cluster diagnostic. NOT a worker profile, migration or release proof.
 * Registration belongs to the controller owner; unregistered/focused routes refuse. */
import assert from 'node:assert/strict';
import {afterAll,beforeEach,it} from 'vitest';
import postgres from 'postgres';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {z} from 'zod';
import {admitSingletonTest} from '../../helpers/ci-singleton-admission';
import {notificationWorkerFixtureDatabase} from './database';
import {notificationDiagnosticOwnership} from './diagnostic-ownership';
import {readDraftDiscardRoleCatalog,assertDraftDiscardRoleCatalog} from '../../helpers/personnel-draft-discard-ci-role-fixture';
import {notificationCanonicalInventoryQuery} from './canonical-inventory-query';
import {normalizeNotificationCanonicalInventory,nativeInventoryCanonical} from './canonical-inventory';
import {inventorySource,inventoryRegularBytes,inventoryHash,assertInventoryLedger,writeInventoryEvidence,InventoryEvidenceSizeError} from './canonical-inventory-evidence';
import {FULL_CI_ROLE_MODE,fullCiRoleReceiptBasename} from '../../../scripts/lib/discard-premigration';
import {catalogueReplayMode,catalogueReplayRoleHash} from '../../../.github/ci/notification-catalogue-replay.mjs';
import {DB_BATCH_FILES} from '../../../.github/ci/manifest.mjs';
import {validateFullCiRoleReceipt} from '../../../.github/ci/run-unit.mjs';
import {notificationCatalogueSessionSchema} from './catalogue-session';

export function registerNotificationFinalCatalogueCapture(file:'test/notification-final-catalogue-baseline.test.ts'|'test/notification-final-catalogue-oid-shift.test.ts'){
 const mode=catalogueReplayMode([file]);assert(mode,'Fixed catalogue replay file required');const ownership=notificationDiagnosticOwnership();
const singletonSchema=z.object({candidate:z.string().regex(/^[a-f0-9]{40}$/),controller:z.string().regex(/^[a-f0-9]{40}$/),runId:z.string().regex(/^[1-9][0-9]*$/),attempt:z.string().regex(/^[1-9][0-9]*$/),unit:z.string().regex(/^db-[a-f0-9]{16}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),file:z.literal(file),profile:z.literal('controlled-database-v1')}).passthrough();
const fixtureSchema=z.object({fixture:z.object({roles:z.array(z.unknown()),edges:z.array(z.unknown()),postgres:z.object({versionNumber:z.number().int(),versionText:z.string(),session:z.string(),current:z.string()})})}).passthrough();
const replaySchema=z.object({mode:z.enum(['baseline','oid-shift']),roleCatalogSha256:z.string(),session:z.object({postmasterStart:z.string(),versionNumber:z.number(),versionText:z.string()})}).passthrough();
beforeEach(()=>ownership.beforeCase());
afterAll(()=>ownership.drain());
it('captures every canonical helper and exact CI source/prerequisite/ledger in one read-only snapshot',context=>ownership.run(context,async()=>{
 const admission=admitSingletonTest(file);assert.equal(admission.mode,'full-ci-singleton','Complete full-CI prerequisites required; focused capture is not interchangeable');
 const source=inventorySource(),directory=admission.evidenceDirectory,binding=notificationWorkerFixtureDatabase();
 assert.equal(binding.namespace,'');assert.equal(binding.migrationUrl.username,'postgres');assert.equal(binding.migrationUrl.password,'');assert.equal(binding.appUrl.username,'ai_hr_app');assert.equal(binding.appUrl.password,'');assert.equal(binding.migrationUrl.port,'5433');
 const singletonBytes=inventoryRegularBytes(join(directory,admission.databaseUnit+'-singleton.json'),1024*1024,true),singleton=singletonSchema.parse(JSON.parse(singletonBytes.toString('utf8')));
 assert.equal(singleton.unit,admission.databaseUnit);assert.equal(singleton.candidate,source.source);assert.equal(singleton.controller,process.env.AIHR_CI_CONTROL_HEAD);assert.equal(singleton.runId,process.env.GITHUB_RUN_ID);assert.equal(singleton.attempt,process.env.GITHUB_RUN_ATTEMPT);
 const prerequisiteName=fullCiRoleReceiptBasename(admission.databaseUnit,0),prerequisiteBytes=inventoryRegularBytes(join(directory,prerequisiteName),32768),prerequisite:unknown=JSON.parse(prerequisiteBytes.toString('utf8'));
 const expectedBinding={mode:FULL_CI_ROLE_MODE,candidate:singleton.candidate,controller:singleton.controller,runId:singleton.runId,attempt:singleton.attempt,unit:singleton.unit,offset:0,planFingerprint:singleton.fingerprint,batchSize:DB_BATCH_FILES,batchFiles:[file]};
 // Reuse the canonical full-CI receipt owner after actual singleton admission.
 const replaySources={ownerSha256:source.replayOwners.owner.sha256,contractSha256:source.replayOwners.contract.sha256};
 const prerequisiteProof=validateFullCiRoleReceipt(prerequisite,expectedBinding,{helperSha256:source.prerequisites.helper.sha256,wrapperSha256:source.prerequisites.wrapper.sha256,orchestrationSha256:source.prerequisites.orchestration.sha256},replaySources);
 const replay=replaySchema.parse(prerequisiteProof.catalogueReplay);assert.equal(replay.mode,mode);
 const prerequisiteFixture=fixtureSchema.parse(prerequisite).fixture;
 const identity={variation:mode,source:source.source,controller:singleton.controller,run:singleton.runId,attempt:singleton.attempt,unit:singleton.unit,planFingerprint:singleton.fingerprint};
 const members:ReturnType<typeof writeInventoryEvidence>[]=[],report:Record<string,unknown>={kind:'NATIVE_CANONICAL_INVENTORY_DIAGNOSTIC_NOT_RELEASE',...identity,complete:false,expectedProfileAuthorized:false,releaseAuthorized:false,
  limits:{caseMs:30000,statementMs:20000,lockMs:300,connectSeconds:2,fileBytes:16*1024*1024},host:{logicalCpus:cpus().length,ramBytes:totalmem(),node:process.version},
  singleton:{sha256:inventoryHash(singletonBytes),raw:JSON.parse(singletonBytes.toString('utf8'))},prerequisites:{file:prerequisiteName,sha256:inventoryHash(prerequisiteBytes),proof:prerequisiteProof,raw:prerequisite},members};
 let connection:ReturnType<typeof postgres>|undefined,stopping:Promise<void>|undefined,failed:unknown,closeFailure:unknown,refused=false,closeRefused=false,phase='source-publication';
 const abort=()=>{if(connection)stopping=connection.end({timeout:0}).catch(error=>{closeRefused=true;closeFailure=error;});};context.signal.addEventListener('abort',abort,{once:true});
 try{
  context.signal.throwIfAborted();members.push(writeInventoryEvidence(directory,'notification-canonical-source.json',{...identity,...source}));
  phase='native-read-only-snapshot';connection=postgres(binding.migrationUrl.href,{max:1,connect_timeout:2,idle_timeout:2,prepare:false,connection:{application_name:'aihr-canonical-inventory',statement_timeout:'20s',lock_timeout:'300ms',default_transaction_read_only:'on',default_transaction_isolation:'repeatable read',search_path:'pg_catalog'}});
  if(context.signal.aborted){abort();context.signal.throwIfAborted();}
  const captured=await connection.begin('isolation level repeatable read read only',async tx=>{
   context.signal.throwIfAborted();
   const [native]=await tx`select current_database()as database,pg_backend_pid()as pid,(select backend_start::text from pg_catalog.pg_stat_activity where pid=pg_backend_pid())as "backendStart",to_char(pg_postmaster_start_time() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')as "postmasterStart",pg_current_snapshot()::text as snapshot,
    current_setting('server_version_num')::int as version,version()as "versionText",session_user::text as session,current_user::text as current,inet_server_addr()='127.0.0.1'::inet as loopback,
    current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as "readOnly",current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock,current_setting('server_encoding')as encoding,current_setting('client_encoding')as "clientEncoding",current_setting('search_path')as "searchPath",current_setting('application_name')as application`;
   const session=notificationCatalogueSessionSchema.parse(native);assert.equal(session.database,binding.database);assert.equal(session.version,prerequisiteFixture.postgres.versionNumber);assert.equal(session.versionText,prerequisiteFixture.postgres.versionText);assert.equal(session.postmasterStart,replay.session.postmasterStart);assert.equal(session.version,replay.session.versionNumber);assert.equal(session.versionText,replay.session.versionText);
   const roles=await readDraftDiscardRoleCatalog(tx);assertDraftDiscardRoleCatalog(roles);assert.equal(catalogueReplayRoleHash(roles),replay.roleCatalogSha256);assert.equal(nativeInventoryCanonical(roles),nativeInventoryCanonical({roles:prerequisiteFixture.roles,edges:prerequisiteFixture.edges}),'Actual native role graph differs from the exact prerequisite receipt');
   const ledger=assertInventoryLedger(source,Array.from(await tx`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`));
   const [row]=await tx.unsafe<{inventory:unknown}[]>(notificationCanonicalInventoryQuery);assert(row,'Native catalogue aggregate missing');context.signal.throwIfAborted();return{session,roles,ledger,inventory:row.inventory};
  });
  report.session=captured.session;report.roles=captured.roles;report.ledger=captured.ledger;
  // Preserve the complete raw native facts BEFORE portability validation.
  phase='raw-evidence-publication';members.push(writeInventoryEvidence(directory,'notification-canonical-raw.json',{...identity,...captured}));
  context.signal.throwIfAborted();phase='lossless-reference-normalization';const normalized=normalizeNotificationCanonicalInventory(captured.inventory);
  members.push(writeInventoryEvidence(directory,'notification-canonical-normalized.json',{...identity,...normalized}));report.normalization={captureFormatVersion:normalized.captureFormatVersion,referenceCounts:normalized.referenceCounts,rawSha256:normalized.rawSha256,normalizedSha256:normalized.normalizedSha256,functionCount:normalized.functionCount,sourceBytes:normalized.sourceBytes,unknownColumns:normalized.unknownColumns,unresolvedPortability:normalized.unresolvedPortability};
  // Re-read BOTH original receipts and all source bytes before publishing complete.
  phase='source-and-receipt-recheck';assert(inventoryRegularBytes(join(directory,prerequisiteName),32768).equals(prerequisiteBytes));assert(inventoryRegularBytes(join(directory,admission.databaseUnit+'-singleton.json'),1024*1024,true).equals(singletonBytes));assert.equal(nativeInventoryCanonical(inventorySource()),nativeInventoryCanonical(source));
 }catch(error){refused=true;failed=error;if(error instanceof InventoryEvidenceSizeError)report.byteRefusal={observedBytes:error.byteLength,maximumBytes:error.maximumBytes};}
 finally{
  try{await stopping;if(connection)await connection.end({timeout:0});if(closeRefused)throw closeFailure;report.socketClosed=true;}
  catch(error){phase='owned-socket-close';failed=refused?new AggregateError([failed,error],'Inventory capture and close refused'):error;refused=true;ownership.poison(error instanceof Error?error:Error('Inventory socket close refused'));report.socketClosed=false;}
  context.signal.removeEventListener('abort',abort);
 }
 if(context.signal.aborted){if(!refused)failed=context.signal.reason??Error('Inventory diagnostic aborted');refused=true;}
 if(refused){writeInventoryEvidence(directory,'notification-canonical-incomplete.json',{...report,complete:false,reason:'capture-or-binding-or-close-refused',phase,cause:failed instanceof Error?failed.name:'unknown'});throw failed;}
 report.complete=true;writeInventoryEvidence(directory,'notification-canonical-report.json',report);
}));

}
