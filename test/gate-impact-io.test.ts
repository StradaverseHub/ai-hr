import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {fsImportsAreWriteOnly,planImpact,IMPACT_POLICY_VERSION} from '../scripts/gate-impact';
const writer="import {mkdirSync as mkdir,appendFileSync as append} from 'node:fs';mkdir(target,{recursive:true});append(target,'timing');";
it('distinguishes actual timing-only filesystem output from reading application inputs',()=>{expect(IMPACT_POLICY_VERSION).toBe(4);expect(fsImportsAreWriteOnly('writer.ts',writer)).toBe(true);expect(fsImportsAreWriteOnly('test/profile.ts',readFileSync('test/profile.ts','utf8'))).toBe(true);});
it.each([
 writer.replace('appendFileSync','readFileSync'),writer.replace('mkdirSync','readdirSync'),
 writer+"const alias=append;",writer+"function shadow(append:any){append(target,'x');}",
 writer+"export {append};",writer+"export {readFileSync} from 'fs';",writer+"const fs=require('fs');",
 writer+"const fs=require(input);", writer+"const load=require;load(unknown);",
 writer+"process.getBuiltinModule(unknown);",writer+"module.require(unknown);",writer+"eval(unknown);",writer+"new Function(unknown);",writer+"const fs=import('fs');",writer+"const fs=import(input);",
 "import * as fs from 'node:fs';fs.appendFileSync(target,'timing');",
 "import fs from 'node:fs';fs.appendFileSync(target,'timing');",
 "import {appendFileSync} from 'node:fs';const write=appendFileSync;write(target,'timing');",
 "import {appendFileSync} from 'node:fs';appendFileSync=other;",
 "import {appendFileSync} from 'node:fs';export const leak={appendFileSync};",
 "import {appendFileSync} from 'node:fs';function appendFileSync(){}",
 "import type {appendFileSync} from 'node:fs';", "import {appendFileSync,readFileSync as read} from 'node:fs';",
])('refuses an unproved filesystem import, alias, shadow or escape',text=>expect(fsImportsAreWriteOnly('writer.ts',text)).toBe(false));
it('keeps true readers and changed writers as consumers while removing only unrelated write-only imports',()=>{
 const change={path:'app/value.ts',status:'M',headText:'export const n=2;',baseText:'export const n=1;',diffLines:[]};
 const files=new Map([['app/value.ts',change.headText],['writer.ts',writer],['test/write.test.ts',"import '../writer';"],['reader.ts',"import {readFileSync} from 'node:fs';readFileSync(input);"],['test/read.test.ts',"import '../reader';"],['test/value.test.ts',"import '../app/value';"]]);
 const plan=planImpact([change],files);expect(plan.run).not.toContain('test/write.test.ts');expect(plan.run).toContain('test/read.test.ts');expect(plan.run).toContain('test/value.test.ts');
 const edited=planImpact([change,{path:'writer.ts',status:'M',headText:writer,baseText:writer+' ',diffLines:[]}],files);expect(edited.run).toContain('test/write.test.ts');
 const unknown=planImpact([change],new Map([...files,['writer.ts',writer+"unknown.readFile(input);"]]));expect(unknown.run).toContain('test/write.test.ts');
});
