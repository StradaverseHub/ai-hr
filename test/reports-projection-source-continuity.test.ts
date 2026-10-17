import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,it,expect} from 'vitest';
import * as ts from 'typescript';
import {reportFixtureDigest} from '../scripts/employee-master-fixture-proof.mjs';
import {REPORTS_PROJECTION_CONTINUITY_NAME,REPORTS_PROJECTION_ARTIFACTS,readReportsProjectionGitEvidence,validateReportsProjectionEvidence,reportsProjectionReceipt} from '../scripts/reports-projection-source-continuity.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const fix='b49e4500d0097d7f620a0e45d01552b979499e84';
// Existing completed fixture proof: IDs/rows stay in the preserved DB, only table digests are copied.
const fixtureProof={"version":1,"metadataDigest":"487510deae033356f85671fc76766894eddc3b2281a7a2158d84165bbb9aa278","stateDigest":"418b286d40cd3d99c548e3adcb24bfc4ee5cf21c49243f2a11dd9e458b4cef79","tables":[{"table":"tenant","rows":3,"digest":"4f43ddd6f8dbc6ebeaa7ad01c107ef86c58275607b178a4395fc7ddb228328a5"},{"table":"company","rows":6,"digest":"6dcc5bf8f1609b9c644d55e48fefe7229ca7bb443284e775ab04017707ca3def"},{"table":"position","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"business_unit","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"department","rows":5,"digest":"b8c436cb1aa43a1d5410ce2b6a13275699e4139e6f0c2bf1e3e280dbf4d20255"},{"table":"cost_center","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"label_company_assignment","rows":5,"digest":"7702fe731f504f99e6933538c649b9335786f2942b6f7b7f7e43fd05c3842908"},{"table":"system_label_criteria_epoch","rows":8,"digest":"ded2d713538059280bb7dd48cb80c724208c908b2fb709e679e11d444a17d4f1"},{"table":"system_label_collision_baseline","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"job_grade","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"grade_group","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"grade_group_member","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"profile_option","rows":548,"digest":"8371dcd59038830b622f77d2c1fbac0243d8f6a495f3edfbab1973fb01d4e640"},{"table":"movement_event_type","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"person","rows":64,"digest":"78fe8913c54c88b21d23485d46c6d3ed2fe7832302f1f0f80d68b2abc6f45a3f"},{"table":"employment","rows":62,"digest":"a173b67ff0fe2fa21fbf8a62974ca59e6d24858506909774d06b6d826cf1c9eb"},{"table":"assignment","rows":63,"digest":"6cb3165da2a04db1db3b666be44b7e77f29cbb575ee57263fcd686b99d50d736"},{"table":"compensation","rows":63,"digest":"e06630945eecced3c0a263ecdf9bfd2266d3066d8f6dbc28e32131c6073c329c"},{"table":"reporting_line","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"role_assignment","rows":12,"digest":"c71362f7cc39cb6fde91ff4b422faa2a80a7a102a9e6fb663e46b9bc2335b947"},{"table":"app_user","rows":10,"digest":"56298c70a1c640d5baf61dc32e135f903c2d00792774b6d07511bf4434fbb429"},{"table":"employee_dependent","rows":2,"digest":"c102b0631149c3375ff773a99fcac4334e2d7c8a18ffb7be30bf82ae587cafff"},{"table":"employee_qualification","rows":2,"digest":"ed3e640d754257adbb5aa9d876f332eb3abd2333e4fc6ad2d9514c6017e6ddac"},{"table":"employee_statutory_my","rows":1,"digest":"a5130147bacf1b6cce9ae8ba4c2d90c1c5e75e861cdfecefc4a9e8510b500c03"},{"table":"payroll_permission_grant","rows":2,"digest":"e92e6d216cc851a59359a467ae901e5f1e161fa338840e88888446989a8a65eb"},{"table":"tenant_module","rows":4,"digest":"7e91cac4084f156bf06c18b84f166c8ed16bd8911bf940dfb218bcc2938da7f6"},{"table":"tenant_setting","rows":2,"digest":"f03973fdff0eb569ecf666808acc2dc17d51db28ec0d9bf5a86f2498a9e9bf94"},{"table":"employee_id_config","rows":1,"digest":"6a8c39351d56ea401c39c1ca953485c5dc7d48261afe34bfa12cda126ccc6d97"},{"table":"employee_draft","rows":1,"digest":"0a029b4d78479f7ca22bd6678ae012a15f8557e4e01618042f5c92eeb108bc6b"},{"table":"employment_tax_selection_my","rows":63,"digest":"803dc5baabed0ac67b9ca4213c41a9111d99625f60dc6a10510344c4e63aafe8"},{"table":"employment_tax_scheme_my","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"leave_type","rows":14,"digest":"44332b012029a0c079959c83aae93334e1b2069343c5e5660bcf5b7fb7c91511"},{"table":"entitlement_template","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"leave_ledger","rows":0,"digest":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},{"table":"domain_event:personnel-source-only","rows":133,"digest":"f8b84941d0b0e8dc8d730ef97144775478e5ee53a9fa0433e526de399d455dde"}]};
const realGit=readReportsProjectionGitEvidence(root,fix);
function evidence(){const git=structuredClone(realGit);return {...git,fixtureProof:structuredClone(fixtureProof),currentProof:{...structuredClone(fixtureProof),metadataDigest:reportFixtureDigest(git.currentMetadata)},artifacts:REPORTS_PROJECTION_ARTIFACTS.map(row=>({...row}))};}
function value(){return {format:1,kind:'reviewed-reports-terminated-scope-continuity',root,candidate:fix,...validateReportsProjectionEvidence(evidence())};}
function receiptState(){const result=value();return {value:result,previous:Buffer.from(JSON.stringify(result,null,2)+'\n'),resumeRecords:{},priorMetadataDigests:{}};}
describe('closed Reports terminated-scope source continuity',()=>{
 it('reconstructs real prepared and corrected Git source, binding exactly one projection patch and the existing35-table state proof',()=>{
  const actual=evidence();expect(actual.fixtureProof.tables).toHaveLength(35);
  expect(reportFixtureDigest(actual.fixtureProof.tables)).toBe(actual.fixtureProof.stateDigest);
  expect(actual.preparedMetadata).toHaveLength(34);expect(actual.currentMetadata).toHaveLength(34);
  expect(()=>validateReportsProjectionEvidence(actual)).not.toThrow();
  expect(actual.currentMetadata.filter((row:{path:string;sha256:string},i:number)=>row.sha256!==actual.preparedMetadata[i].sha256).map((row:{path:string})=>row.path)).toEqual(['core/employee-master-projection.ts']);
 });
 it('refuses unrelated source, altered prepared proof, patch drift, state drift and artifact drift',()=>{
  for(const mode of ['third-path','prepared','patch','new-blob','old-source','state','tables','artifact']){const actual=evidence();
   if(mode==='third-path'){actual.currentMetadata[0].sha256='f'.repeat(64);actual.currentProof.metadataDigest=reportFixtureDigest(actual.currentMetadata);}
   if(mode==='prepared')actual.preparedMetadata[0].sha256='f'.repeat(64);
   if(mode==='patch')actual.change.patch+='\n';if(mode==='new-blob')actual.change.newBlob='f'.repeat(40);
   if(mode==='old-source'){actual.currentMetadata=structuredClone(actual.preparedMetadata);actual.currentProof.metadataDigest=actual.fixtureProof.metadataDigest;}
   if(mode==='state')actual.currentProof.stateDigest='f'.repeat(64);if(mode==='tables')actual.currentProof.tables[0].rows++;
   if(mode==='artifact')actual.artifacts[0].sha256='f'.repeat(64);
   expect(()=>validateReportsProjectionEvidence(actual),mode).toThrow();
  }
 });
 it('creates one immutable receipt and permits subsequent unchanged corrected resumes',()=>{
  const first=reportsProjectionReceipt({...receiptState(),previous:undefined});expect(first.create).toBe(true);expect(first.name).toBe(REPORTS_PROJECTION_CONTINUITY_NAME);
  const state=receiptState(),records={old:{candidate:'a'.repeat(40)},corrected:{candidate:fix,reportsSourceContinuity:first.reference,priorStoppedReceipt:{resumeReceipt:'old'}}};
  const later=reportsProjectionReceipt({...state,resumeRecords:records,priorMetadataDigests:{old:state.value.preparationProof.metadataDigest,corrected:state.value.currentProof.metadataDigest}});
  expect(later.create).toBe(false);expect(later.reference).toEqual(first.reference);
 });
 it('rejects changed/missing receipts and reference loss, unknown historical source or source downgrade',()=>{
  const state=receiptState(),reference=reportsProjectionReceipt({...state,previous:undefined}).reference;
  expect(()=>reportsProjectionReceipt({...state,previous:Buffer.concat([state.previous,Buffer.from(' ')])})).toThrow();
  const corrected={candidate:fix,reportsSourceContinuity:reference};
  expect(()=>reportsProjectionReceipt({...state,previous:undefined,resumeRecords:{corrected},priorMetadataDigests:{corrected:state.value.currentProof.metadataDigest}})).toThrow();
  expect(()=>reportsProjectionReceipt({...state,resumeRecords:{corrected:{candidate:fix}},priorMetadataDigests:{corrected:state.value.currentProof.metadataDigest}})).toThrow();
  expect(()=>reportsProjectionReceipt({...state,resumeRecords:{unknown:{candidate:fix}},priorMetadataDigests:{unknown:'f'.repeat(64)}})).toThrow();
  expect(()=>reportsProjectionReceipt({...state,resumeRecords:{corrected,old:{candidate:'a'.repeat(40),priorStoppedReceipt:{resumeReceipt:'corrected'}}},priorMetadataDigests:{corrected:state.value.currentProof.metadataDigest,old:state.value.preparationProof.metadataDigest}})).toThrow();
  const old=evidence();old.currentMetadata=structuredClone(old.preparedMetadata);old.currentProof.metadataDigest=old.fixtureProof.metadataDigest;expect(()=>validateReportsProjectionEvidence(old)).toThrow();
 });
 it('keeps normal strict source proof and forces continuity after any recorded transition before identity-guarded wx creation',()=>{
  const runner=readFileSync(new URL('../scripts/dev-browser-original18.mjs',import.meta.url),'utf8'),helper=readFileSync(new URL('../scripts/reports-projection-source-continuity.mjs',import.meta.url),'utf8');
  expect(runner).toContain('JSON.stringify(proof)!==JSON.stringify(fixture.proof)||transitioned');
  expect(runner).toContain("fs.existsSync(path.join(out,REPORTS_PROJECTION_CONTINUITY_NAME))||Object.values(resumeRecords??{}).some(record=>record.reportsSourceContinuity!==undefined)");
  const identities=runner.indexOf('const resumePrincipals=await proveIdentities('),creation=runner.indexOf('if(reportsContinuity?.create)writeNew(');expect(identities).toBeGreaterThan(0);expect(creation).toBeGreaterThan(identities);
  expect(runner).toContain('reportsSourceContinuity:reportsContinuity.reference');
  expect(helper).toContain('maxBuffer:16000000');for(const forbidden of ['.insert(','.delete(','CREATE DATABASE','TRUNCATE','readEmployeeMasterFixtureProof('])expect(helper).not.toContain(forbidden);
  // Crypto hashing legitimately calls update; database or other mutation receivers do not.
  const hashReceiver=(expression:ts.Expression):boolean=>ts.isCallExpression(expression)&&(
   ts.isIdentifier(expression.expression)&&expression.expression.text==='createHash'||
   ts.isPropertyAccessExpression(expression.expression)&&expression.expression.name.text==='update'&&hashReceiver(expression.expression.expression));
  const visit=(node:ts.Node)=>{
   if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='update')expect(hashReceiver(node.expression.expression)).toBe(true);
   ts.forEachChild(node,visit);
  };
  visit(ts.createSourceFile('continuity.mjs',helper,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS));
 });
});
