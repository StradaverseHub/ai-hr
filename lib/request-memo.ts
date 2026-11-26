/** One read per page render (ADR 0181 live work queues addendum, step Q0): the app frame's bell and menu and the page's
 * own sections ask some owners the same question in one render. `perRenderRead` lets them share one answer.
 *
 * The memo lives in the render's read scope (lib/request-read-scope.ts): it never outlives its request and never
 * reaches another one. Outside a render (a route handler, a job, a test without `withRequestReadScope`) there is no
 * scope, and every call reads afresh exactly as before. Inside one, answers are keyed by the session object itself
 * (lib/session.ts getSession is memoised per request, so the frame and the page hold the same object) and by the
 * caller's key, so two identities, or one identity with different claims, never share an answer. A failed read is
 * dropped from the memo, so the next caller reads again, as an unshared read would. */
import {requestReadScope} from './request-read-scope';

const scopes=new WeakMap<object,WeakMap<object,Map<string,Promise<unknown>>>>();

/** Whether a render's read scope is active, i.e. whether `perRenderRead` can share an answer. */
export function inRenderReadScope():boolean{return requestReadScope()!==undefined;}

/** `read()` once per render, session object and key; outside a render, `read()` every call. */
export function perRenderRead<T>(session:object,key:string,read:()=>Promise<T>):Promise<T>{
 const scope=requestReadScope();
 if(!scope)return read();
 let owners=scopes.get(scope);
 if(!owners){owners=new WeakMap();scopes.set(scope,owners);}
 let reads=owners.get(session);
 if(!reads){reads=new Map();owners.set(session,reads);}
 const known=reads.get(key) as Promise<T>|undefined;
 if(known)return known;
 const pending=read();
 reads.set(key,pending);
 const own=reads;
 pending.catch(()=>{if(own.get(key)===pending)own.delete(key);});
 return pending;
}
