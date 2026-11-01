/** Step 5c — the only way a scripts/teras command writes a file.
 *
 * Outputs are local reports and drafts: a .json, .txt or .md file either outside this repository (a scratch
 * folder) or under its git-ignored .improve/ folder. Every other path inside the repository is refused, so no
 * engine command can write the harness spec, the gate, the semantic model's disclosure classes, mandate job
 * types, migrations or workflows (test/improvement-engine-boundary.test.ts calls this with each of them). */
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPO_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
export class OutputRefused extends Error{constructor(readonly path:string,readonly reason:string){super(`Refused to write ${path}: ${reason}`);this.name='OutputRefused';}}

/** The absolute path a write would go to, or a refusal. Writes nothing. */
export function localOutputPath(path:string,root:string=REPO_ROOT):string{
 const target=resolve(root,path);
 if(!/\.(json|txt|md)$/.test(target))throw new OutputRefused(path,'only .json, .txt or .md reports');
 const inside=relative(root,target);
 if(!inside.startsWith('..')&&!isAbsolute(inside)&&!inside.startsWith('.improve'+sep))throw new OutputRefused(path,'inside the repository, outside .improve/');
 return target;
}
export function writeLocalOutput(path:string,content:string):string{
 const target=localOutputPath(path);
 mkdirSync(dirname(target),{recursive:true});
 writeFileSync(target,content.endsWith('\n')?content:content+'\n');
 return target;
}
