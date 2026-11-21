/** The switch back to the owners' own reads for docs/adr/2026-11-10-home-request-read-scope.md decision 13: the Home
 * greeting's own facts, the notices card, Today's Needs you statement, the assigned-performance check and At a glance's
 * "away" read. Inside `withOwnerCardSectionReads` every one of them reads exactly as before that decision, owner by
 * owner, so equivalence proofs can compare both paths in one process. It changes no authority and no result. */
import {AsyncLocalStorage} from 'node:async_hooks';

const ownerReads=new AsyncLocalStorage<true>();
/** Every decision-13 read inside `work` reads through its owners exactly as before. Equivalence proofs only. */
export function withOwnerCardSectionReads<T>(work:()=>Promise<T>):Promise<T>{return ownerReads.run(true,work);}
export function ownerCardSectionReads():boolean{return ownerReads.getStore()===true;}
