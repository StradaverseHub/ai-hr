/** Hosted diagnostic, equivalence part A of test/performance/home-manager-card-reads.test.ts (same seed, same blocks;
 * see that file's state for the split). It runs only when the hosted focused controller selects this file. */
import {vi} from 'vitest';
const state=vi.hoisted(()=>((globalThis as {__aihrHomeCardReads?:{session:unknown;run:string|null}}).__aihrHomeCardReads??={session:undefined,run:null}));
vi.mock('../../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
import './home-manager-card-reads.test';
