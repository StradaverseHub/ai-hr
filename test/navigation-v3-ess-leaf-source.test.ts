/** Complete source-history/query controls only, never native permission or page acceptance. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import ts from 'typescript';
import {expect,it} from 'vitest';
const root=fileURLToPath(new URL('..',import.meta.url));
const read=(name:string)=>readFileSync(resolve(root,name),'utf8');
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
type Inverse={base:string;files:Record<string,{originalSha256:string;currentSha256:string;changes:{start:number;end:number;before:string;after:string}[]}>};
const inverse=JSON.parse(read('test/fixtures/navigation-v3-ess-leaf-source-inverse.json')) as Inverse;
function original(name:string){
 const source=read(name),row=inverse.files[name];expect(row).toBeDefined();expect(sha(source)).toBe(row.currentSha256);
 const lines=source.match(/[^\n]*\n|[^\n]+$/g)??[];let frontier=lines.length;
 for(const edit of row.changes){expect(edit.start>=0&&edit.start<=edit.end&&edit.end<=frontier).toBe(true);expect(lines.slice(edit.start,edit.end).join('')).toBe(edit.after);lines.splice(edit.start,edit.end-edit.start,...(edit.before.match(/[^\n]*\n|[^\n]+$/g)??[]));frontier=edit.start;}
 const restored=lines.join('');expect(sha(restored)).toBe(row.originalSha256);return restored;
}
const parse=(name:string,text:string)=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function fn(source:ts.SourceFile,name:string){const node=source.statements.find(value=>ts.isFunctionDeclaration(value)&&value.name?.text===name);expect(node).toBeDefined();return node as ts.FunctionDeclaration;}
function unwrap(value:ts.Expression):ts.Expression{return ts.isParenthesizedExpression(value)||ts.isAsExpression(value)?unwrap(value.expression):value;}
function returned(node:ts.FunctionDeclaration){expect(node.body?.statements).toHaveLength(1);const value=node.body!.statements[0];expect(ts.isReturnStatement(value)&&value.expression).toBeTruthy();return unwrap((value as ts.ReturnStatement).expression!);}
function carrier(node:ts.FunctionDeclaration){const call=returned(node) as ts.CallExpression;expect(ts.isCallExpression(call)&&call.expression.getText()==='withTenant').toBe(true);expect(call.arguments).toHaveLength(2);const arrow=call.arguments[1];expect(ts.isArrowFunction(arrow)).toBe(true);return arrow as ts.ArrowFunction;}
const leaves=[
 ['core/read.ts','assignmentHistory','readAssignmentHistoryRowsTx','assignmentHistoryTx'],
 ['core/pay-components.ts','listEmploymentPayComponents','readEmploymentPayComponentRowsTx','listEmploymentPayComponentsTx'],
 ['core/cp38.ts','listCp38','readCp38RowsTx','listCp38Tx'],
 ['core/comp.ts','compensationHistoryDetailed','readCompensationHistoryRowsTx','compensationHistoryDetailedTx'],
 ['core/profile-options.ts','listAllProfileOptions','readAllProfileOptionRowsTx','listAllProfileOptionsTx'],
 ['core/shift-arrangement.ts','shiftArrangementHistory','readShiftArrangementHistoryRowsTx','shiftArrangementHistoryTx'],
] as const;
it('restores every complete changed legacy owner and facade to the exact qualified Draft parent',()=>{
 expect(inverse.base).toBe('d45c1fbc4e91aa0edb261b52e4fa8016e223740e');expect(Object.keys(inverse.files).sort()).toEqual(['core/comp.ts','core/cp38.ts','core/pay-components.ts','core/profile-options.ts','core/profile-view.ts','core/read.ts','core/shift-arrangement.ts','packs/attendance/service.ts','packs/payroll/service.ts','lib/ai/provider-data-source-manifest.ts','lib/ai/module-agent-source-manifest.ts','test/employee-draft-presentation-manifests.test.ts'].sort());
 for(const name of Object.keys(inverse.files))expect(original(name).length).toBeGreaterThan(0);
});
it('shares every exact original leaf query and transformation rather than a second SQL spelling',()=>{
 for(const [file,legacy,query]of leaves){const old=parse(file,original(file)),current=parse(file,read(file)),callback=carrier(fn(old,legacy)),owner=fn(current,query);
  if(ts.isBlock(callback.body))expect(owner.body!.statements.map(statement=>statement.getText())).toEqual(callback.body.statements.map(statement=>statement.getText()));
  else expect(unwrap(returned(owner)).getText()).toBe(callback.body.getText());
 }
 const old=parse('core/profile-view.ts',original('core/profile-view.ts')),leaf=parse('packs/attendance/own-profile-read.ts',read('packs/attendance/own-profile-read.ts'));
 let callback:ts.ArrowFunction|undefined;function visit(node:ts.Node){if(ts.isArrowFunction(node)&&ts.isBlock(node.body)&&node.body.getText().includes('const groupOn=await scheduleGroupLookupTx'))callback=node;ts.forEachChild(node,visit);}visit(fn(old,'readOwnProfileFacts'));
 expect(callback&&ts.isBlock(callback.body)).toBe(true);const statements=(callback!.body as ts.Block).statements;
 expect(fn(leaf,'readOwnProfileAttendanceSummaryRowsTx').body!.statements.map(statement=>statement.getText())).toEqual(statements.map(statement=>statement.getText().replaceAll('emp.defaultShiftId','defaultShiftId')));
});
it('retains the original legacy carrier and exposes only explicit same-Tx delegation without authority flags',()=>{
 for(const [file,legacy,query,seam]of leaves){const source=read(file),current=parse(file,source),callback=carrier(fn(current,legacy));expect(ts.isCallExpression(callback.body)&&callback.body.expression.getText()===query).toBe(true);
  const helper=returned(fn(current,seam));expect(ts.isCallExpression(helper)&&helper.expression.getText()===query).toBe(true);expect(fn(current,seam).parameters.map(parameter=>parameter.name.getText())).toEqual(['tx',legacy==='listAllProfileOptions'?'opts':legacy==='listCp38'?'p':'employmentId']);
 }
 for(const file of ['core/cp38.ts','core/comp.ts'])expect(read(file)).toContain("import { withPayrollHistoryTenant as withTenant");
 const payroll=read('packs/payroll/service.ts'),attendance=read('packs/attendance/service.ts');for(const name of ['listEmploymentPayComponentsTx','listCp38Tx','compensationHistoryDetailedTx'])expect(payroll).toContain(name);for(const name of ['shiftArrangementHistoryTx','ownProfileAttendanceSummaryTx'])expect(attendance).toContain(name);
 const leaf=read('packs/attendance/own-profile-read.ts');expect(leaf).not.toMatch(/withTenant|createDb|new Pool|readOnlySnapshot|for\(['"]update/);
});
it('changes no facts composition, visibility, financial projection or date capture outside the exact attendance leaf call',()=>{
 const name='core/profile-view.ts',old=parse(name,original(name)),current=parse(name,read(name));
 function attendanceCall(source:ts.SourceFile){let call:ts.CallExpression|undefined;function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText()==='withTenant'&&node.arguments[1]?.getText().includes('scheduleGroupLookupTx'))call=node;ts.forEachChild(node,visit);}visit(fn(source,'readOwnProfileFacts'));return call;}
 const before=attendanceCall(old);expect(before).toBeDefined();let after:ts.CallExpression|undefined;function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText()==='withTenant'&&node.arguments[1]?.getText().includes('ownProfileAttendanceSummaryTx'))after=node;ts.forEachChild(node,visit);}visit(fn(current,'readOwnProfileFacts'));expect(after).toBeDefined();
 expect(fn(old,'readOwnProfileFacts').getText().replace(before!.getText(),after!.getText())).toBe(fn(current,'readOwnProfileFacts').getText());expect(fn(current,'readOwnProfileMovementComparison').getText()).toBe(fn(old,'readOwnProfileMovementComparison').getText());
});
