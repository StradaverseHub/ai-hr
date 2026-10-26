/** Actual installed Next CLI type-check entry, used only for owned negative controls. */
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {assertNextCacheInvocation} from './next-build-cache-policy.mjs';
assertNextCacheInvocation(process.env);
const source=resolve(process.cwd()),require=createRequire(join(source,'package.json'));
const {runTypeCheckCli}=require('next/dist/lib/typescript/runTypeCheckCli');
const config=JSON.parse(readFileSync(join(source,'.next/required-server-files.json')));
if(config.config?.experimental?.useTypeScriptCli!==true||config.config?.typescript?.ignoreBuildErrors===true||config.config?.typescript?.tsconfigPath!=='tsconfig.build.json')
 throw Error('Exact actual Next build typecheck path required');
await runTypeCheckCli({baseDir:source,tsConfigPath:'tsconfig.build.json',tscPath:require.resolve('typescript/lib/tsc.js'),cacheDir:join(source,'.next/cache')})
 .then(()=>console.log('ACTUAL_NEXT_APPLICATION_TYPECHECK_COMPLETED'))
 .catch(error=>{console.error(error);process.exitCode=1;});
