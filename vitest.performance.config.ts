/** Explicit development benchmarks, outside the ordinary test inventory. No conditional skips. */
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
export default defineConfig({
 resolve:{alias:{'@':fileURLToPath(new URL('.',import.meta.url)),'server-only':fileURLToPath(new URL('./test/stubs/server-only.ts',import.meta.url))}},
 test:{
  server:{deps:{inline:['@workos-inc/authkit-nextjs']}},
  projects:[{extends:true,test:{name:'performance',setupFiles:['./test/env.ts'],globalSetup:['./test/global-setup.ts'],
   fileParallelism:false,maxWorkers:1,testTimeout:480000,hookTimeout:30000,include:['test/performance/*.profile.ts']}}],
 },
});
