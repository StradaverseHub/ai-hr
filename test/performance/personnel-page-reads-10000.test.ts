/** Hosted diagnostic: the real Personnel page, private search and export for an HR administrator and a
 * scoped manager over 10000 fictional employments. It runs only when the hosted focused controller
 * selects this file; every other Vitest run skips it. No installation is touched; no release evidence. */
import {afterAll,beforeAll,describe,it,vi} from 'vitest';
const state=vi.hoisted(()=>{
 const file='test/performance/personnel-page-reads-10000.test.ts';
 let selected=false;
 try{selected=(JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]') as unknown[]).includes(file);}catch{selected=false;}
 const hostedFocused=selected&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.GITHUB_WORKFLOW==='alpha-focused-checks'&&Boolean(process.env.AIHR_FOCUSED_EVIDENCE_DIR);
 const shared=((globalThis as {__personnelPageDiagnostic?:{session?:unknown;scopeCookie?:string}}).__personnelPageDiagnostic??={});
 return {hostedFocused,shared};
});
vi.mock('../../lib/session',async importOriginal=>({...(await importOriginal<typeof import('../../lib/session')>()),getSession:async()=>state.shared.session}));
vi.mock('next/cache',()=>({revalidatePath:()=>{},revalidateTag:()=>{}}));
vi.mock('next/navigation',()=>({
 redirect:(path:string)=>{throw new Error('NEXT_REDIRECT:'+path);},notFound:()=>{throw new Error('NEXT_NOT_FOUND');},
 useRouter:()=>({refresh:()=>{},push:()=>{},replace:()=>{}}),usePathname:()=>'/admin/personnel',useSearchParams:()=>new URLSearchParams(),
}));
vi.mock('next/headers',()=>({
 cookies:async()=>({get:(name:string)=>name==='company_scope'&&state.shared.scopeCookie!==undefined?{value:state.shared.scopeCookie}:undefined}),
 headers:async()=>new Headers(),
}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const {readFileSync}=await import('node:fs');
 const {fileURLToPath}=await import('node:url');
 const messages=JSON.parse(readFileSync(fileURLToPath(new URL('../../messages/en.json',import.meta.url)),'utf8'));
 return {getLocale:async()=>'en',getTranslations:async(ns?:string|{namespace?:string})=>createTranslator({locale:'en',messages,
  namespace:(typeof ns==='string'?ns:ns?.namespace) as never,onError:()=>{}})};
});
import {closeAll,migrateTestDb} from '../harness';
import {restoreWorkforceCapabilityCatalogue} from './personnel-scale-fixture';
import {runPersonnelPageDiagnostic} from './personnel-page-reads-harness';

describe.skipIf(!state.hostedFocused)('Personnel page reads at 10000 fictional employments',()=>{
 beforeAll(migrateTestDb,120_000);
 afterAll(async()=>{try{await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);
 it('records round trips, owners, wall time and nested plans for both roles',async()=>{
  await runPersonnelPageDiagnostic({size:10000,evidenceName:'personnel-page-reads-10000.json',budgetMs:540_000});
 },900_000);
});
