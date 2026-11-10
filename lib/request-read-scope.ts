/** The read scope of one server render: the Today sections, the shell's approvals and the Performance block of one
 * page request share one read-only snapshot session per identity (db/client.ts withSharedReadSnapshot `scope`).
 *
 * Inside a React server request, `cache` returns the same object for the whole render and nothing afterwards: the
 * scope never outlives its request and never reaches another request. Outside one (a route handler, a job, a test)
 * `cache` is a passthrough, so there is no request scope and every composition keeps its own snapshot, exactly as
 * before. A test or diagnostic that models one page render supplies its scope explicitly with `withRequestReadScope`.
 * The scope carries no identity: a session inside it is keyed by the exact transaction identity, so two identities
 * in one render never share a snapshot. Each carrier of a scope's session reads the registered request preamble
 * (core/home-request-preamble.ts, docs/adr/2026-11-10-home-request-read-scope.md decision 12) for its own login. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {cache} from 'react';

const explicit=new AsyncLocalStorage<object>();
const rendered=cache(():object=>({}));

export function requestReadScope():object|undefined{
 const supplied=explicit.getStore();
 if(supplied)return supplied;
 const scope=rendered();
 // A passthrough cache answers a fresh object each call: no request is rendering.
 return rendered()===scope?scope:undefined;
}

/** One modelled request render: every composition inside `work` shares `scope`. */
export function withRequestReadScope<T>(scope:object,work:()=>Promise<T>):Promise<T>{return explicit.run(scope,work);}
