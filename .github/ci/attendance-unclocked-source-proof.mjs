/** Original32case source-preservation only; never executes financial fixtures. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const BASELINE_SHA="3e1e32008ae85b6e9be2513ed01dcf08ae07d9f1574074bd68bf252d3a71605d";
// Board 3 commit 9ffcd9251fe0148a57a4cb93c4ed9f9b290432ab configured submission routing in the remaining suite.
const BOARD_FIXTURE_SHA="55ad96bdedb31895bf4596dae57197019d1848c4753fefc929b67a3808ce4394";
const BOARD_FIXTURE_IMPORT="import {seedAttendanceSubmissionBase} from './helpers/attendance-submission-fixture';\n";
const ORIGINAL_RESET_HOOK="beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});";
const BOARD_RESET_HOOK=ORIGINAL_RESET_HOOK.replace('seedBase()','seedAttendanceSubmissionBase()');
const START=" it.each([...( ['cash','toil'] as const).flatMap(mode=>[\n";
const END=" it('banks canonical policy TOIL";
const DESCRIBE="describe('immutable non-payable policy part storage',()=>{\n";
// Gates 45792803264/45797094461 timed out the first TOIL case at 36 s against 30 s; the bound timeout text is pinned exactly.
const CASE_TIMEOUT=["// Explicit timeout: each case is one full HR-attested request/approval/payroll or TOIL journey.",
 "// Measured on a8f7255df: 11.2-11.7 s per case alone (focused 45807279918), but 19-20 s in a full",
 "// gate's shared DB unit and 36.1/36.3 s for the first case while the unit starts, timing out",
 "// against the global 30 s twice (gates 45792803264, 45797094461, unit db-150ef0d500e2e18c, whose",
 "// hint cost was the median, so rebalancing cannot add headroom). 60 s keeps ~1.7x over the worst",
 "// observed case. Cash mode runs the same case body and shares the limit.",
 "const ATTESTED_CASE_TIMEOUT_MS=60_000;",""].join('\n');
const CASE_CLOSE="\n });\n\n});\n}\n",TIMED_CASE_CLOSE="\n },ATTESTED_CASE_TIMEOUT_MS);\n\n});\n}\n";
export const UNCLOCKED_SPLIT_PATHS=Object.freeze({baseline:'.github/ci/diagnostics/fixtures/attendance-unclocked-before-financial-split.ts.txt',remaining:'test/attendance-policy-storage-unclocked.test.ts',financial:'test/attendance-policy-storage-attested-financial.test.ts',toil:'test/attendance-policy-storage-attested-toil.test.ts',financialFixture:'test/attendance-policy-storage-attested-financial-cases.ts',boardFixture:'test/helpers/attendance-submission-fixture.ts'});
export function readUnclockedSplitSources(root){return Object.fromEntries(Object.entries(UNCLOCKED_SPLIT_PATHS).map(([k,p])=>[k,readFileSync(join(root,p),'utf8')]));}
export function verifyUnclockedSplit(sources){
 const original=sources.baseline;assert.equal(createHash('sha256').update(original).digest('hex'),BASELINE_SHA,'Frozen financial source oracle changed');
 for(const marker of [START,END,DESCRIBE])assert.equal(original.split(marker).length,2,'Unique nonempty financial boundary required');
 const start=original.indexOf(START),end=original.indexOf(END),bodyStart=original.indexOf(DESCRIBE)+DESCRIBE.length;
 assert(bodyStart>0&&start>bodyStart&&end>start&&end-start>10000);
 assert.equal(createHash('sha256').update(sources.boardFixture).digest('hex'),BOARD_FIXTURE_SHA,'Changed Board 3 submission fixture source');
 assert(sources.remaining.startsWith(BOARD_FIXTURE_IMPORT)&&sources.remaining.split(BOARD_FIXTURE_IMPORT).length===2,'Exact Board 3 submission fixture import required');
 assert.equal(sources.remaining.split(BOARD_RESET_HOOK).length,2,'Exact Board 3 submission fixture reset hook required');
 const remaining=sources.remaining.slice(BOARD_FIXTURE_IMPORT.length).replace(BOARD_RESET_HOOK,ORIGINAL_RESET_HOOK);
 assert.equal(remaining,original.slice(0,start)+original.slice(end),'Changed non-financial registrations, hooks or source');
 const financial=original.slice(0,bodyStart)+original.slice(start,end)+'});\n';
 const marker='let b:Base,ctx:SessionContext;',needle=" ])('carries real HR-attested";
 assert.equal(financial.split(marker).length,2);assert.equal(financial.split(needle).length,2);
 const at=financial.indexOf(marker),registration="export function registerAttestedFinancialCases(mode:'cash'|'toil'){\n if(mode!=='cash'&&mode!=='toil')throw new Error('One exact attested financial mode required');\n";
 const split=financial.slice(0,at)+registration+financial.slice(at).replace(needle," ].filter(row=>row.mode===mode))('carries real HR-attested")+'}\n';
 // The only permitted edit: one measured per-case timeout, declared once before the describe and passed as it.each's timeout argument.
 assert.equal(split.split(DESCRIBE).length,2);assert(split.endsWith(CASE_CLOSE),'Unique financial callback close required');
 assert.equal(sources.financialFixture,split.replace(DESCRIBE,CASE_TIMEOUT+DESCRIBE).slice(0,-CASE_CLOSE.length)+TIMED_CASE_CLOSE,'Changed original matrix, callback, financial/time controls, per-case fixture or measured case timeout');
 const wrapper=mode=>"import {registerAttestedFinancialCases} from './attendance-policy-storage-attested-financial-cases';\nregisterAttestedFinancialCases('"+mode+"');\n";
 assert.equal(sources.financial,wrapper('cash'),'Exact cash partition registration required');
 assert.equal(sources.toil,wrapper('toil'),'Exact TOIL partition registration required');
 return Object.freeze({kind:'SOURCE_PRESERVATION_ONLY_NOT_RUNTIME_OR_RELEASE',baselineSha256:BASELINE_SHA,originalCases:32,remainingCases:14,financialCases:18,financialPartitions:{cash:9,toil:9},caseTimeoutMs:60000,allRegistrationBodiesAndValuesUnchanged:true,samePerCaseResetAndLiveGetters:true,boardSubmissionFixtureBound:true,releaseAuthorized:false});
}
