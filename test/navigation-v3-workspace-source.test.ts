/** Source reconstruction/projection controls only. Native admission has independent DB controls. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it} from 'vitest';
const read=(name:string)=>readFileSync(name,'utf8'),sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Inverse={base:string;files:Record<string,{originalSha256:string;currentSha256:string;changes:{start:number;end:number;before:string;after:string}[]}>};
const inverse=JSON.parse(read('test/fixtures/navigation-v3-workspace-source-inverse.json')) as Inverse;
function original(name:string){
 const source=read(name),row=inverse.files[name];expect(row).toBeDefined();expect(sha(source)).toBe(row.currentSha256);
 const lines=source.match(/[^\n]*\n|[^\n]+$/g)??[];let frontier=lines.length;
 for(const edit of row.changes){expect(edit.start>=0&&edit.start<=edit.end&&edit.end<=frontier).toBe(true);expect(lines.slice(edit.start,edit.end).join('')).toBe(edit.after);lines.splice(edit.start,edit.end-edit.start,...(edit.before.match(/[^\n]*\n|[^\n]+$/g)??[]));frontier=edit.start;}
 const restored=lines.join('');expect(sha(restored)).toBe(row.originalSha256);return restored;
}
const parse=(name:string,value:string)=>ts.createSourceFile(name,value,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function fn(source:ts.SourceFile,name:string){const node=source.statements.find(value=>ts.isFunctionDeclaration(value)&&value.name?.text===name);expect(node).toBeDefined();return node as ts.FunctionDeclaration;}
function runBody(node:ts.FunctionDeclaration){const declaration=(node.body!.statements[0] as ts.VariableStatement).declarationList.declarations[0];expect(declaration.name.getText()).toBe('run');const initializer=declaration.initializer!;expect(ts.isArrowFunction(initializer)&&ts.isBlock(initializer.body)).toBe(true);return (initializer as ts.ArrowFunction).body as ts.Block;}
it('restores every complete changed parent file, including the inherited four-case source control and generated identities',()=>{
 expect(inverse.base).toBe('e2dfc879d571f2fae7d38f20c9e244d0ec78383f');
 expect(Object.keys(inverse.files).sort()).toEqual(['core/profile-edit.ts','lib/ai/provider-data-source-manifest.ts','lib/ai/module-agent-source-manifest.ts','test/navigation-v3-ess-leaf-source.test.ts'].sort());
 for(const file of Object.keys(inverse.files))expect(original(file).length).toBeGreaterThan(0);
});
it('shares the complete exact original workspace query/projection and retains its legacy admission and carrier branches',()=>{
 const name='core/profile-edit.ts',old=parse(name,original(name)),current=parse(name,read(name));
 const legacy=fn(old,'readOwnProfileWorkspace'),next=fn(current,'readOwnProfileWorkspace'),before=runBody(legacy),after=runBody(next),shared=fn(current,'readOwnProfileWorkspaceRowsTx');
 expect(after.statements.map(row=>row.getText())).toEqual([...before.statements.slice(0,2).map(row=>row.getText()),'return readOwnProfileWorkspaceRowsTx(tx,policy,p.employmentId,Boolean(existingTx));']);
 expect(shared.body!.statements.map(row=>row.getText())).toEqual(before.statements.slice(2).map(row=>row.getText().replace('p.employmentId,false,Boolean(existingTx)','employmentId,false,forUpdate').replace('subject,Boolean(existingTx)','subject,forUpdate')));
 expect(legacy.parameters.map(row=>row.getText())).toEqual(next.parameters.map(row=>row.getText()));
 expect(legacy.body!.statements.slice(1).map(row=>row.getText())).toEqual(next.body!.statements.slice(1).map(row=>row.getText()));
});
it('preserves every other original function, native row-lock query, country boundary, hard bound and public CAS algorithm byte for byte',()=>{
 const name='core/profile-edit.ts',old=parse(name,original(name)),current=parse(name,read(name));
 for(const node of old.statements)if(ts.isFunctionDeclaration(node)&&node.name&&node.name.text!=='readOwnProfileWorkspace')expect(fn(current,node.name.text).getText()).toBe(node.getText());
 const masters=fn(current,'mastersTx').getText();expect(masters.match(/\.limit\(501\)/g)).toHaveLength(3);expect(masters).toContain('rows.length>500');expect(masters).toContain('tx,{forUpdate:lock}');expect(masters).toContain('revision:sql<string>`xmin::text`');
 const additions=current.statements.filter(ts.isFunctionDeclaration).map(node=>node.name!.text).filter(name=>!old.statements.some(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name));
 expect(additions).toEqual(['readOwnProfileWorkspaceRowsTx','readOwnProfileWorkspacePresentationTx']);
});
it('admits only through the actual native policy then fresh principal owners before explicit nonlocking query delegation',()=>{
 const source=parse('core/profile-edit.ts',read('core/profile-edit.ts')),course=fn(source,'readOwnProfileWorkspacePresentationTx');
 expect(course.parameters.map(row=>row.getText())).toEqual(['tx:Tx','ctx:SessionContext','p:{employmentId?:string}={}']);
 expect(course.body!.statements.map(row=>row.getText())).toEqual([
  'const policy=await freshProfilePresentationPolicyTx(tx,ctx);',
  'await assertAiPrincipalTx(tx,policy.ctx);',
  'return readOwnProfileWorkspaceRowsTx(tx,policy,p.employmentId,false);',
 ]);
 expect(course.getText()).not.toMatch(/withTenant|withPayrollHistoryTenant|createDb|new Pool|existingTx|readOnlySnapshot|forUpdate:/);
});
