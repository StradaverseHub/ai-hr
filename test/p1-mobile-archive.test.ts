/** Git ignore semantics independently evaluate the shipping allowlist against emitted relative imports. */
import {it,expect} from 'vitest';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,relative} from 'node:path';

it('every recursive portable runtime source is admitted, while private and server sentinels remain excluded',()=>{
 const root=resolve('.'),dir=mkdtempSync(join(tmpdir(),'aihr-eas-closure-'));
 try {
  execFileSync('git',['init','-q',dir]);writeFileSync(join(dir,'.gitignore'),readFileSync('.easignore'));
  const files=execFileSync('git',['ls-files','mobile','lib'],{encoding:'utf8'}).trim().split('\n');
  const starts=files.filter(file=>file.startsWith('mobile/')&&/\.[cm]?[jt]sx?$/.test(file));
  const queue=[...starts],seen=new Set<string>(),missing:string[]=[];
  while(queue.length){
   const file=queue.shift()!;if(seen.has(file))continue;seen.add(file);
   if(!/\.[cm]?[jt]sx?$/.test(file))continue;
   const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
   for(const imported of ts.preProcessFile(output,true,true).importedFiles){
    if(!imported.fileName.startsWith('.'))continue;
    const stem=resolve(dirname(file),imported.fileName),candidate=[stem,...['.ts','.tsx','.mjs','.js','.json','/index.ts','/index.tsx'].map(ext=>stem+ext)].find(p=>existsSync(p)&&statSync(p).isFile());
    if(!candidate){missing.push(`${file} -> ${imported.fileName}`);continue;}
    queue.push(relative(root,candidate));
   }
  }
  expect(missing).toEqual([]);expect(seen.has('lib/mobile-api/v2/team.ts')).toBe(true);
  const ignored=(paths:string[])=>execFileSync('git',['-C',dir,'check-ignore','--no-index','--stdin'],{input:paths.join('\n')+'\n',encoding:'utf8'}).trim().split('\n').filter(Boolean);
  // check-ignore exits1 when no matches, so request excluded sentinels in the same call.
  const privatePaths=['.env.local','lib/session.ts','db/client.ts','mobile/credentials.json','mobile/private.key'];
  const omitted=ignored([...seen,...privatePaths]);expect(omitted.filter(p=>seen.has(p))).toEqual([]);
  expect(omitted.filter(p=>privatePaths.includes(p)).sort()).toEqual(privatePaths.sort());
 } finally {rmSync(dir,{recursive:true,force:true});}
});
