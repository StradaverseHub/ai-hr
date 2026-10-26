/** Source-preservation guard only. Never imports application fixtures or grants release authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const BASELINE_SHA="b1a7affec35ccb616ddebf276dc211f24ef77a85d6fbdf5016c9bc6dad6b61f0";
const FIXTURE_IMPORT="\nimport {OLD_USING,NEW_USING,originalLiveUsing,WRITE_TABLES,ADMIN_IN_SET_FN,ADMIN_IN_SET_USING,\n currentFeedbackPolicies,currentProfilePolicies,attempt,proj,bothWays,empRow,REPORT,tally,\n registerR395WriteFixture,compareGenericWriteContext,assertGenericWriteNonVacuity,type Outcome} from './r395-write-fixture';\nimport {WRITE_CONTEXT_PARTITIONS} from './r395-write-context-partitions.mjs';\nregisterR395WriteFixture('primary');\n\n";
const REGISTER_HEAD="/** One isolated fixture per Vitest file; optional reports identify their partition explicitly. */\nlet registered = false;\nexport function registerR395WriteFixture(reportLabel: 'primary' | 'secondary') {\n  if (registered || !['primary','secondary'].includes(reportLabel)) throw new Error('One named r395 write fixture per isolated file');\n  registered = true;\n";
const REGISTER_FOOT="  beforeAll(() => {\n    expect(CONTEXTS).toHaveLength(24);\n    expect(CONTEXTS[0].name).toBe('employee (leaf2)');\n    expect(CONTEXTS[16].name).toBe('hr_admin group-wide');\n  });\n}\n\n";
const EXPORTS=";\nexport {OLD_USING,NEW_USING,originalLiveUsing,WRITE_TABLES,ADMIN_IN_SET_FN,ADMIN_IN_SET_USING,\n currentFeedbackPolicies,currentProfilePolicies,attempt,proj,bothWays,empRow,REPORT,tally};\nexport type {Outcome};\n";
const SECONDARY_HEAD="/** Remaining original contexts; preserve every write/row/error comparison and independent non-vacuity. */\nimport {describe,it} from 'vitest';\nimport {registerR395WriteFixture,compareGenericWriteContext,assertGenericWriteNonVacuity} from './r395-write-fixture';\nimport {WRITE_CONTEXT_PARTITIONS} from './r395-write-context-partitions.mjs';\nregisterR395WriteFixture('secondary');\n\n";
const PARTITIONS_TEXT="/** Scheduling data only. Every original context runs once; repeated controls add coverage. */\nexport const WRITE_CONTEXT_PARTITIONS = Object.freeze({\n primary:Object.freeze([0,2,3,5,7,10,11,13,14,16,18,21]),\n secondary:Object.freeze([1,4,6,8,9,12,15,17,19,20,22,23]),\n supplemental:Object.freeze([0,16]),\n});\n";

export const WRITE_SPLIT_PATHS=Object.freeze({baseline:'.github/ci/diagnostics/fixtures/r395-write-before-split.ts.txt',fixture:'test/r395-write-fixture.ts',primary:'test/r395-write-path-equivalence.test.ts',secondary:'test/r395-write-contexts-secondary.test.ts',partitions:'test/r395-write-context-partitions.mjs'});
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
 for(const [key,value] of Object.entries({fixture,primary,secondary:SECONDARY_HEAD+secondaryBlock,partitions:PARTITIONS_TEXT}))assert.equal(sources[key],value,'Unreviewed source/coverage change in '+key);
 return Object.freeze({kind:'SOURCE_PRESERVATION_ONLY_NOT_RUNTIME_OR_RELEASE',baselineSha256:BASELINE_SHA,originalCases:88,expectedSplitCases:91,originalContextCount:24,partitionSizes:[12,12],supplementalContexts:[0,16],originalCallbacksHooksQueriesAndNonVacuityPreserved:true,originalOther63CasesPreserved:true,releaseAuthorized:false});
}
