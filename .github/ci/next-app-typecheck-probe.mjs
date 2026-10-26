/** Actual installed Next CLI type-check entry, used only for owned negative controls. */
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {assertNextCacheInvocation} from './next-build-cache-policy.mjs';
assertNextCacheInvocation(process.env);
const source=resolve(process.cwd()),require=createRequire(join(source,'package.json'));
const {runTypeCheckCli}=require('next/dist/lib/typescript/runTypeCheckCli');
let config;
if(process.env.AIHR_NEXT_BUILD_CACHE_MODE==='recover'){
 process.env.NODE_ENV='production';const raw=require('next/dist/server/config');const load=raw.default??raw;config={config:await load(require('next/dist/shared/lib/constants').PHASE_PRODUCTION_BUILD,source)};
}else config=JSON.parse(readFileSync(join(source,'.next/required-server-files.json')));
if(config.config?.experimental?.useTypeScriptCli!==true||config.config?.typescript?.ignoreBuildErrors===true||config.config?.typescript?.tsconfigPath!=='tsconfig.build.json')
 throw Error('Exact actual Next build typecheck path required');
await runTypeCheckCli({baseDir:source,tsConfigPath:'tsconfig.build.json',tscPath:require.resolve('typescript/lib/tsc.js'),cacheDir:join(source,'.next/cache')})
 .then(()=>console.log('ACTUAL_NEXT_APPLICATION_TYPECHECK_COMPLETED'))
 .catch(error=>{console.error(error);process.exitCode=1;});
