/** Source-preservation guard only. Never imports application fixtures or grants release authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const BASELINE_SHA="b1a7affec35ccb616ddebf276dc211f24ef77a85d6fbdf5016c9bc6dad6b61f0";
// Exact reviewed PR62 additions. The original split oracle remains immutable.
const REVIEWED_DELTA_SHA='f9f477e5d99eaf78642dccdf1567d736fa2af7755cbdee25f57c614e78a8a2df';
const REVIEWED_SOURCES=Object.freeze({
 org:Object.freeze({baselineSha256:'03576b64d447b8338f724f0625a53de16ce473dee94a32ec3eb3bb8d2a9671a0',reviewedSha256:'2512747bb6c33510d2458365a980917f990cc2de6844a64bf027cf58a7b535fe',hunks:3}),
 fixture:Object.freeze({baselineSha256:'c6bf6085da5642b78873a69dbb801e6143f042c2091b71fe94d97681a55d4828',reviewedSha256:'d325fa02e1a5be12e6bfc363aa38c3c743c29b61f3bc239386421e1dbf50956a',hunks:6}),
});
const sha=text=>createHash('sha256').update(text).digest('hex');
function readReviewedDelta(bytes){
 assert.equal(sha(bytes),REVIEWED_DELTA_SHA,'Reviewed fixture delta changed');
 const delta=JSON.parse(bytes);
 assert.equal(delta.kind,'EXACT_REVIEWED_R395_PARENT_CONTROL_DELTA_NOT_RELEASE');
 assert.equal(delta.baseCommit,'4f66743d56f34755bb662824e163bfbef5f6ff17');
 assert.equal(delta.reviewedCommit,'92a2c35b00c9830df6a2817b98b78af62e1474c0');
 assert.equal(delta.releaseAuthorized,false);assert.deepEqual(Object.keys(delta.files).sort(),['fixture','org']);
 return delta;
}
function applyReviewedDelta(original,key,delta){
 const pinned=REVIEWED_SOURCES[key],entry=delta.files[key];
 assert.equal(sha(original),pinned.baselineSha256,'Original '+key+' source changed');
 assert.equal(entry.baselineSha256,pinned.baselineSha256);assert.equal(entry.reviewedSha256,pinned.reviewedSha256);
 assert.equal(entry.edits.length,pinned.hunks);let output=original;
 for(const {before,after} of entry.edits){
  assert(typeof before==='string'&&before.length>0&&typeof after==='string'&&after.length>0&&before!==after,'Nonempty exact reviewed hunk required');
  assert.equal(output.split(before).length,2,'Reviewed '+key+' hunk must match exactly once');
  output=output.replace(before,()=>after);
 }
 assert.equal(sha(output),pinned.reviewedSha256,'Reviewed '+key+' reconstruction differs');
 return output;
}
const FIXTURE_IMPORT="\nimport {OLD_USING,NEW_USING,originalLiveUsing,WRITE_TABLES,ADMIN_IN_SET_FN,ADMIN_IN_SET_USING,\n currentFeedbackPolicies,currentProfilePolicies,attempt,proj,bothWays,empRow,REPORT,tally,\n registerR395WriteFixture,compareGenericWriteContext,assertGenericWriteNonVacuity,type Outcome} from './r395-write-fixture';\nimport {WRITE_CONTEXT_PARTITIONS} from './r395-write-context-partitions.mjs';\nregisterR395WriteFixture('primary');\n\n";
const REGISTER_HEAD="/** One isolated fixture per Vitest file; optional reports identify their partition explicitly. */\nlet registered = false;\nexport function registerR395WriteFixture(reportLabel: 'primary' | 'secondary' | 'tertiary') {\n  if (registered || !['primary','secondary','tertiary'].includes(reportLabel)) throw new Error('One named r395 write fixture per isolated file');\n  registered = true;\n";
const REGISTER_FOOT="  beforeAll(() => {\n    expect(CONTEXTS).toHaveLength(24);\n    expect(CONTEXTS[0].name).toBe('employee (leaf2)');\n    expect(CONTEXTS[16].name).toBe('hr_admin group-wide');\n  });\n}\n\n";
const EXPORTS=";\nexport {OLD_USING,NEW_USING,originalLiveUsing,WRITE_TABLES,ADMIN_IN_SET_FN,ADMIN_IN_SET_USING,\n currentFeedbackPolicies,currentProfilePolicies,attempt,proj,bothWays,empRow,REPORT,tally};\nexport type {Outcome};\n";
const SECONDARY_HEAD="/** Remaining original contexts; preserve every write/row/error comparison and independent non-vacuity. */\nimport {describe,it} from 'vitest';\nimport {registerR395WriteFixture,compareGenericWriteContext,assertGenericWriteNonVacuity} from './r395-write-fixture';\nimport {WRITE_CONTEXT_PARTITIONS} from './r395-write-context-partitions.mjs';\nregisterR395WriteFixture('secondary');\n\n";
const PARTITIONS_TEXT="/** Scheduling data only. Every original context runs once; repeated controls add coverage. */\nexport const WRITE_CONTEXT_PARTITIONS = Object.freeze({\n primary:Object.freeze([0,1,6,10,11,16,20,21]),\n secondary:Object.freeze([3,5,12,14,15,17,19,23]),\n tertiary:Object.freeze([2,4,7,8,9,13,18,22]),\n supplemental:Object.freeze([0,16]),\n});\n";

export const WRITE_SPLIT_PATHS=Object.freeze({baseline:'.github/ci/diagnostics/fixtures/r395-write-before-split.ts.txt',fixture:'test/r395-write-fixture.ts',primary:'test/r395-write-path-equivalence.test.ts',secondary:'test/r395-write-contexts-secondary.test.ts',tertiary:'test/r395-write-contexts-tertiary.test.ts',partitions:'test/r395-write-context-partitions.mjs',org:'test/r395-org.ts',orgBaseline:'.github/ci/diagnostics/fixtures/r395-org-before-reviewed-parent-bindings.ts.txt',reviewedDelta:'.github/ci/diagnostics/fixtures/r395-reviewed-parent-controls.json'});
export function readWriteSplitSources(root){return Object.fromEntries(Object.entries(WRITE_SPLIT_PATHS).map(([k,p])=>[k,readFileSync(join(root,p),'utf8')]));}
function once(text,marker){assert.equal(text.split(marker).length,2,'Required unique source marker: '+marker);const at=text.indexOf(marker);assert(at>=0);return at;}
export function verifyWriteSplit(sources){
 const original=sources.baseline;assert.equal(createHash('sha256').update(original).digest('hex'),BASELINE_SHA,'Frozen source oracle changed');
 const start=once(original,"describe('r395 write path — setup'"),genericStart=once(original,"describe('r395 write path — generic"),genericEnd=once(original,"describe('r395 write path — person and employment");
 assert(start<genericStart&&genericStart<genericEnd,'Invalid nonempty source boundaries');
 const generic=original.slice(genericStart,genericEnd),callbackStart=once(generic,'    async (i) => {'),callbackEnd=once(generic,'\n    180_000,');assert(callbackEnd>callbackStart);
 let callback=generic.slice(callbackStart,callbackEnd).trim();assert(callback.endsWith('},'));callback=callback.slice(0,-1);
 const nv=once(generic,"  it('the generic writes are not vacuous:"),nvStart=generic.indexOf('() => {',nv),nvEnd=generic.indexOf('\n  });',nvStart);assert(nvStart>nv&&nvEnd>nvStart);
 const nonvacuity=generic.slice(nvStart,nvEnd)+'\n  }';
 const hookStart=once(original,'beforeAll(async () => {'),prefix=original.slice(0,hookStart),hooks=original.slice(hookStart,start);assert(hooks.length>2000&&prefix.length>4000);
 const oldReport='writeFileSync(process.env.R395_REPORT, JSON.stringify(REPORT, null, 2))';once(hooks,oldReport);
 const fixture=prefix+REGISTER_HEAD+hooks.replace(oldReport,"writeFileSync(process.env.R395_REPORT + '.' + reportLabel + '.json', JSON.stringify(REPORT, null, 2))")+REGISTER_FOOT+
  'export const compareGenericWriteContext = '+callback.replace('async (i) =>','async (i: number) =>')+';\nexport const assertGenericWriteNonVacuity = '+nonvacuity+EXPORTS;
 const importStart=once(original,"import { randomUUID }"),importEnd=once(original,'\nconst OLD_USING');assert(importEnd>importStart);
 let primaryBlock=generic.replace('it.each([...Array(24).keys()])','it.each(WRITE_CONTEXT_PARTITIONS.primary)').replace(callback,'compareGenericWriteContext').replace(nonvacuity,'assertGenericWriteNonVacuity');
 const primary=original.slice(0,importStart)+original.slice(importStart,importEnd)+FIXTURE_IMPORT+original.slice(start,genericStart)+primaryBlock+original.slice(genericEnd);
 let secondaryBlock=primaryBlock.replace('WRITE_CONTEXT_PARTITIONS.primary','WRITE_CONTEXT_PARTITIONS.secondary').replace("'the generic writes are not vacuous: inserts were both allowed and RLS-refused somewhere, and updates returned rows'","'the generic writes are not vacuous: inserts were both allowed and RLS-refused somewhere, and updates returned rows (second partition)'");
 const at=once(secondaryBlock,"  it('the generic writes are not vacuous:");secondaryBlock=secondaryBlock.slice(0,at)+"  it.each(WRITE_CONTEXT_PARTITIONS.supplemental)('supplemental non-vacuity control context #%i', compareGenericWriteContext, 180_000);\n\n"+secondaryBlock.slice(at);
 const tertiary=(SECONDARY_HEAD+secondaryBlock).replace("registerR395WriteFixture('secondary')","registerR395WriteFixture('tertiary')").replace('WRITE_CONTEXT_PARTITIONS.secondary','WRITE_CONTEXT_PARTITIONS.tertiary').replace('(second partition)','(third partition)');
 const delta=readReviewedDelta(sources.reviewedDelta);
 const reviewedFixture=applyReviewedDelta(fixture,'fixture',delta);
 const reviewedOrg=applyReviewedDelta(sources.orgBaseline,'org',delta);
 for(const [key,value] of Object.entries({fixture:reviewedFixture,org:reviewedOrg,primary,secondary:SECONDARY_HEAD+secondaryBlock,tertiary,partitions:PARTITIONS_TEXT}))assert.equal(sources[key],value,'Unreviewed source/coverage change in '+key);
 return Object.freeze({kind:'SOURCE_PRESERVATION_ONLY_NOT_RUNTIME_OR_RELEASE',baselineSha256:BASELINE_SHA,reviewedFixtureDeltaSha256:REVIEWED_DELTA_SHA,reviewedFixtureCommit:delta.reviewedCommit,reviewedOrgSha256:REVIEWED_SOURCES.org.reviewedSha256,reviewedWriteFixtureSha256:REVIEWED_SOURCES.fixture.reviewedSha256,originalCases:88,expectedSplitCases:94,originalContextCount:24,partitionSizes:[8,8,8],supplementalContexts:[0,16],originalCallbacksHooksQueriesAndNonVacuityPreserved:true,originalOther63CasesPreserved:true,releaseAuthorized:false});
}
