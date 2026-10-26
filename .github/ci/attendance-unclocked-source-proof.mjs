/** Original32case source-preservation only; never executes financial fixtures. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const BASELINE_SHA="3e1e32008ae85b6e9be2513ed01dcf08ae07d9f1574074bd68bf252d3a71605d";
const START=" it.each([...( ['cash','toil'] as const).flatMap(mode=>[\n";
const END=" it('banks canonical policy TOIL";
const DESCRIBE="describe('immutable non-payable policy part storage',()=>{\n";
export const UNCLOCKED_SPLIT_PATHS=Object.freeze({baseline:'.github/ci/diagnostics/fixtures/attendance-unclocked-before-financial-split.ts.txt',remaining:'test/attendance-policy-storage-unclocked.test.ts',financial:'test/attendance-policy-storage-attested-financial.test.ts',toil:'test/attendance-policy-storage-attested-toil.test.ts',financialFixture:'test/attendance-policy-storage-attested-financial-cases.ts'});
export function readUnclockedSplitSources(root){return Object.fromEntries(Object.entries(UNCLOCKED_SPLIT_PATHS).map(([k,p])=>[k,readFileSync(join(root,p),'utf8')]));}
export function verifyUnclockedSplit(sources){
 const original=sources.baseline;assert.equal(createHash('sha256').update(original).digest('hex'),BASELINE_SHA,'Frozen financial source oracle changed');
 for(const marker of [START,END,DESCRIBE])assert.equal(original.split(marker).length,2,'Unique nonempty financial boundary required');
 const start=original.indexOf(START),end=original.indexOf(END),bodyStart=original.indexOf(DESCRIBE)+DESCRIBE.length;
 assert(bodyStart>0&&start>bodyStart&&end>start&&end-start>10000);
 assert.equal(sources.remaining,original.slice(0,start)+original.slice(end),'Changed non-financial registrations, hooks or source');
 const financial=original.slice(0,bodyStart)+original.slice(start,end)+'});\n';
 const marker='let b:Base,ctx:SessionContext;',needle=" ])('carries real HR-attested";
 assert.equal(financial.split(marker).length,2);assert.equal(financial.split(needle).length,2);
 const at=financial.indexOf(marker),registration="export function registerAttestedFinancialCases(mode:'cash'|'toil'){\n if(mode!=='cash'&&mode!=='toil')throw new Error('One exact attested financial mode required');\n";
 assert.equal(sources.financialFixture,financial.slice(0,at)+registration+financial.slice(at).replace(needle," ].filter(row=>row.mode===mode))('carries real HR-attested")+'}\n','Changed original matrix, callback, financial/time controls or per-case fixture');
 const wrapper=mode=>"import {registerAttestedFinancialCases} from './attendance-policy-storage-attested-financial-cases';\nregisterAttestedFinancialCases('"+mode+"');\n";
 assert.equal(sources.financial,wrapper('cash'),'Exact cash partition registration required');
 assert.equal(sources.toil,wrapper('toil'),'Exact TOIL partition registration required');
 return Object.freeze({kind:'SOURCE_PRESERVATION_ONLY_NOT_RUNTIME_OR_RELEASE',baselineSha256:BASELINE_SHA,originalCases:32,remainingCases:14,financialCases:18,financialPartitions:{cash:9,toil:9},allRegistrationBodiesAndValuesUnchanged:true,samePerCaseResetAndLiveGetters:true,releaseAuthorized:false});
}
