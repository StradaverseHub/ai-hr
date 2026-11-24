/** The read scope of one server render: the Today sections, the shell's approvals and the Performance block of one
 * page request share one read-only snapshot session per identity (db/client.ts withSharedReadSnapshot `scope`).
 *
 * Inside a React server request, `cache` returns the same object for the whole render and nothing afterwards: the
 * scope never outlives its request and never reaches another request. Outside one (a route handler, a job, a test)
 * `cache` is a passthrough, so there is no request scope and every composition keeps its own snapshot, exactly as
 * before. A test or diagnostic that models one page render supplies its scope explicitly with `withRequestReadScope`.
 * Since ADR 0181 package 1.1 the scope is also the default for every other read of the render: a `withTenant` read
 * inside no shared session joins its identity's session here (db/shared-read.ts defaultRequestReadScope).
 * The scope carries no identity: a session inside it is keyed by the exact transaction identity, so two identities
 * in one render never share a snapshot. Each carrier of a scope's session reads the registered request preamble
 * (core/home-request-preamble.ts, docs/adr/2026-11-10-home-request-read-scope.md decision 12) for its own login. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {cache} from 'react';
import {registerRequestScopeResolver} from '../db/shared-read';

const explicit=new AsyncLocalStorage<object>();
const rendered=cache(():object=>({}));

export function requestReadScope():object|undefined{
 const supplied=explicit.getStore();
 if(supplied)return supplied;
 const scope=rendered();
 // A passthrough cache answers a fresh object each call: no request is rendering.
 return rendered()===scope?scope:undefined;
}

// ADR 0181 decision 2 (package 1.1): during a render, every `withTenant` read inside no shared session joins this
// scope's session for its identity by default (db/shared-read.ts defaultRequestReadScope). Registered on load, so a
// process that never loads this module (a job, a script, the worker) keeps every owner's own transaction.
registerRequestScopeResolver(requestReadScope);

/** One modelled request render: every composition inside `work` shares `scope`. */
export function withRequestReadScope<T>(scope:object,work:()=>Promise<T>):Promise<T>{return explicit.run(scope,work);}
