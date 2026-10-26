/** Original32case source-preservation only; never executes financial fixtures. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const BASELINE_SHA="3e1e32008ae85b6e9be2513ed01dcf08ae07d9f1574074bd68bf252d3a71605d";
const START=" it.each([...( ['cash','toil'] as const).flatMap(mode=>[\n";
const END=" it('banks canonical policy TOIL";
const DESCRIBE="describe('immutable non-payable policy part storage',()=>{\n";
export const UNCLOCKED_SPLIT_PATHS=Object.freeze({baseline:'.github/ci/diagnostics/fixtures/attendance-unclocked-before-financial-split.ts.txt',remaining:'test/attendance-policy-storage-unclocked.test.ts',financial:'test/attendance-policy-storage-attested-financial.test.ts'});
export function readUnclockedSplitSources(root){return Object.fromEntries(Object.entries(UNCLOCKED_SPLIT_PATHS).map(([k,p])=>[k,readFileSync(join(root,p),'utf8')]));}
export function verifyUnclockedSplit(sources){
 const original=sources.baseline;assert.equal(createHash('sha256').update(original).digest('hex'),BASELINE_SHA,'Frozen financial source oracle changed');
 for(const marker of [START,END,DESCRIBE])assert.equal(original.split(marker).length,2,'Unique nonempty financial boundary required');
 const start=original.indexOf(START),end=original.indexOf(END),bodyStart=original.indexOf(DESCRIBE)+DESCRIBE.length;
 assert(bodyStart>0&&start>bodyStart&&end>start&&end-start>10000);
 assert.equal(sources.remaining,original.slice(0,start)+original.slice(end),'Changed non-financial registrations, hooks or source');
 assert.equal(sources.financial,original.slice(0,bodyStart)+original.slice(start,end)+'});\n','Changed financial callbacks, table values, hooks or assertions');
 return Object.freeze({kind:'SOURCE_PRESERVATION_ONLY_NOT_RUNTIME_OR_RELEASE',baselineSha256:BASELINE_SHA,originalCases:32,remainingCases:14,financialCases:18,allRegistrationBodiesAndValuesUnchanged:true,samePerCaseResetAndLiveGetters:true,releaseAuthorized:false});
}
