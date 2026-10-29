/** Immutable worker bytes only. This independent artifact never grants release authority. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const [root,output,source]=process.argv.slice(2);
if(process.argv.length!==5||!root||!output||!/^[a-f0-9]{40}$/.test(source??''))throw Error('Usage: node scripts/bank-import-worker-package.mjs <candidate-root> <output-directory> <exact40sha>');
const runtime={node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime};
const result=spawnSync('python3',['-I',fileURLToPath(new URL('./bank-import-worker-package.py',import.meta.url)),root,output,source],{input:JSON.stringify(runtime),encoding:'utf8',stdio:['pipe','pipe','inherit'],maxBuffer:1024**2});
if(result.error)throw result.error;
if(result.stdout)process.stdout.write(result.stdout);
process.exitCode=result.status??1;
