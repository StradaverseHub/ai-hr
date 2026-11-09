import {expect,it} from 'vitest';
import {ownCatalogueReplayPrefix} from './fixtures/notification-worker/replay-prefix-ownership';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function time(){let now=0;const tasks=new Set<{at:number;work:()=>void}>();return{now:()=>now,schedule:(work:()=>void,ms:number)=>{const row={at:now+ms,work};tasks.add(row);return()=>{tasks.delete(row);};},advance(ms:number){now+=ms;for(const row of [...tasks])if(row.at<=now){tasks.delete(row);row.work();}},pending:()=>tasks.size};}
it('owns a late native callback beyond outer transport rejection and preserves distinct cleanup failures before any migration result',async()=>{
 const clock=time(),entered=deferred(),release=deferred(),outer=Error('outer transport'),inner=Error('actual finally'),closing=Error('socket close');let proved=false;
 const work=ownCatalogueReplayPrefix(async(_active,callback)=>{void callback(async()=>{entered.resolve();await release.promise;throw inner;}).catch(()=>{});await entered.promise;throw outer;},async()=>{throw closing;},async()=>{proved=true;},clock);
 let settled=false;const result=work.catch((error:unknown)=>error).finally(()=>{settled=true;});await entered.promise;await Promise.resolve();expect(settled).toBe(false);release.resolve();
 const failure=await result;expect(failure).toBeInstanceOf(AggregateError);if(!(failure instanceof AggregateError))throw Error('Compound refusal required');expect(failure.errors).toEqual([outer,closing,inner]);expect(proved).toBe(false);expect(clock.pending()).toBe(0);
});
it('closes at actual30s, refuses every later callback and cannot report backend quiescence from a socket promise',async()=>{
 const clock=time(),entered=deferred(),release=deferred();let closed=0,proved=false,late:((work:()=>Promise<void>)=>Promise<void>)|undefined;
 const work=ownCatalogueReplayPrefix(async(_active,callback)=>{late=callback;return callback(async()=>{entered.resolve();await release.promise;return'fixed';});},async()=>{closed++;},async()=>{proved=true;},clock);
 await entered.promise;clock.advance(30000);await Promise.resolve();expect(closed).toBe(1);expect(()=>late!(async()=>{})).toThrow('deadline');release.resolve();await expect(work).rejects.toThrow();expect(proved).toBe(false);expect(closed).toBe(1);expect(clock.pending()).toBe(0);
});
it('requires explicit backend verification after callback and close, while retaining the original aggregate deadline',async()=>{
 const clock=time(),order:string[]=[];
 expect(await ownCatalogueReplayPrefix(async(_active,callback)=>callback(async()=>{order.push('callback');return'fixed';}),async()=>{order.push('close');},async active=>{active();order.push('native-backend-proof');},clock)).toBe('fixed');
 expect(order).toEqual(['callback','close','native-backend-proof']);expect(clock.pending()).toBe(0);
 const other=time(),failure:unknown=await ownCatalogueReplayPrefix(async(_active,callback)=>callback(async()=>1),async()=>{},async active=>{other.advance(30000);active();},other).catch((error:unknown)=>error);
 expect(failure).toBeInstanceOf(AggregateError);if(!(failure instanceof AggregateError))throw Error('Both deadline and native proof refusal retained');expect(failure.errors.some(error=>error instanceof Error&&error.message.includes('backend proof'))).toBe(true);
});

it('owns observation socket cancellation and its drain when native absence proof is blocked at30s',async()=>{
 const clock=time(),entered=deferred(),release=deferred();let closed=0;
 const work=ownCatalogueReplayPrefix(async(_active,callback)=>callback(async()=>1),async()=>{},async()=>{entered.resolve();await release.promise;},clock,async()=>{closed++;release.resolve();});
 await entered.promise;clock.advance(30000);await expect(work).rejects.toThrow('30s');expect(closed).toBe(1);expect(clock.pending()).toBe(0);
});
