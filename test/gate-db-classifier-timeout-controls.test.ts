/** Ordinary source/counter-wire controls, not native classifier timing. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('checks thirteen fixed diagnostic source and counter controls without skips',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','.github/ci/diagnostics/db-classifier-timeout.test.py','-v'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);expect(result.stdout).toBe('');expect(output).toMatch(/Ran 13 tests in [0-9.]+s\n\nOK\n$/);process.stdout.write(output);
},20000);


// Actual invocation source only: never imports or executes the native wrapper.
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function fixedAbsoluteInvocation(text:string){
 const file=ts.createSourceFile('native-wrapper.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const calls:ts.CallExpression[]=[],declarations:ts.VariableDeclaration[]=[];
 const visit=(node:ts.Node)=>{if(ts.isCallExpression(node))calls.push(node);if(ts.isVariableDeclaration(node))declarations.push(node);ts.forEachChild(node,visit);};visit(file);
 const script=declarations.filter(node=>node.name.getText(file)==='script');
 const spawn=calls.filter(node=>node.expression.getText(file)==='spawnSync');
 const guards=calls.map(node=>node.getText(file));
 if(script.length!==1||script[0].initializer?.getText(file)!=="fileURLToPath(new URL('../.github/ci/diagnostics/db-classifier-timeout.py',import.meta.url))"
  ||spawn.length!==1||spawn[0].arguments[0]?.getText(file)!=="'/usr/bin/python3'"
  ||spawn[0].arguments[1]?.getText(file)!=="['-I','-B',script]"
  ||!guards.includes('expect(realpathSync(script)).toBe(script)')
  ||!guards.includes("expect(script).toBe(join(realpathSync(process.cwd()),'.github/ci/diagnostics/db-classifier-timeout.py'))"))throw Error('Exact canonical module-owned Python invocation required');
 return {script:'module-owned-absolute',python:'/usr/bin/python3',flags:['-I','-B']};
}
it('binds the real native wrapper to one canonical absolute Python script and rejects the exact failed parent invocation',()=>{
 const path='test/gate-db-classifier-timeout-diagnostic.test.ts',source=readFileSync(path,'utf8');
 const inverse=JSON.parse(readFileSync('.github/ci/diagnostics/db-classifier-profile-absolute-invocation-inverse.json','utf8'));
 const parent=Buffer.from(inverse.files[path].originalBase64,'base64').toString('utf8');
 expect(fixedAbsoluteInvocation(source)).toEqual({script:'module-owned-absolute',python:'/usr/bin/python3',flags:['-I','-B']});
 expect(()=>fixedAbsoluteInvocation(parent)).toThrow('Exact canonical module-owned Python invocation required');
 for(const changed of [
  source.replace("['-I','-B',script]","['-I','-B','.github/ci/diagnostics/db-classifier-timeout.py']"),
  source.replace("new URL('../.github/ci/diagnostics/db-classifier-timeout.py',import.meta.url)","new URL('../foreign.py',import.meta.url)"),
  source.replace('expect(realpathSync(script)).toBe(script)',"expect(realpathSync(script)).toBe(script+'/alias')"),
  source.replace("expect(script).toBe(join(realpathSync(process.cwd()),'.github/ci/diagnostics/db-classifier-timeout.py'))","expect(script).toBe(script)"),
  source.replace("['-I','-B',script]","['-I',script]"),
 ]){expect(changed).not.toBe(source);expect(()=>fixedAbsoluteInvocation(changed)).toThrow('Exact canonical module-owned Python invocation required');}
});
