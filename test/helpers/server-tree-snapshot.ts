/** Test-only: a server component tree as plain data, so a DB test can render a layout or page as a server render runs
 * its server components and compare two renders by deep equality (test/route-read-budget.test.ts). Never a product
 * path. Unlike test/helpers/server-tree.ts (which hands a React tree to react-dom), nothing here needs a browser
 * renderer, a router or providers.
 *
 * - An async function component is a server component: it is called with its props and its result resolved.
 * - A sync function component is called once; if it throws (a client component's hook outside a renderer) it is a
 *   leaf, recorded as {type, props} with its props resolved.
 * - Promises (streamed facts passed as props) are awaited; functions become '[function]'; dates their ISO text.
 * `normalize` replaces values that are meant to differ per render (a fresh revision id) before comparison. */
import {Fragment,Suspense,isValidElement} from 'react';

const AsyncFunction=(async()=>{}).constructor;
export type Normalize=(key:string,value:unknown)=>unknown;
const isThenable=(value:unknown):value is PromiseLike<unknown>=>value!==null&&(typeof value==='object'||typeof value==='function')&&typeof (value as {then?:unknown}).then==='function';

function typeName(type:unknown):string{
 if(typeof type==='string')return type;
 if(type===Fragment)return 'Fragment';
 if(type===Suspense)return 'Suspense';
 const named=type as {displayName?:string;name?:string;render?:{name?:string};$$typeof?:symbol}|null;
 return named?.displayName||named?.name||named?.render?.name||String(named?.$$typeof??'Anonymous');
}

export async function serverTreeSnapshot(node:unknown,normalize:Normalize=(_key,value)=>value,depth=0):Promise<unknown>{
 if(depth>400)throw new Error('Server tree too deep');
 if(node===null||node===undefined||typeof node==='boolean')return null;
 if(typeof node==='string'||typeof node==='number'||typeof node==='bigint')return String(node);
 if(typeof node==='function')return '[function]';
 if(typeof node==='symbol')return String(node);
 if(isThenable(node))return serverTreeSnapshot(await node,normalize,depth+1);
 if(Array.isArray(node))return Promise.all(node.map(child=>serverTreeSnapshot(child,normalize,depth+1)));
 if(node instanceof Date)return node.toISOString();
 if(node instanceof Map)return serverTreeSnapshot([...node.entries()],normalize,depth+1);
 if(node instanceof Set)return serverTreeSnapshot([...node.values()],normalize,depth+1);
 if(isValidElement(node)){
  const {type,props}=node as {type:unknown;props:Record<string,unknown>};
  if(typeof type==='function'){
   if(type instanceof AsyncFunction)return {type:typeName(type),rendered:await serverTreeSnapshot(await (type as (p:unknown)=>Promise<unknown>)(props),normalize,depth+1)};
   let rendered:unknown,leaf=false;
   try{rendered=(type as (p:unknown)=>unknown)(props);}catch{leaf=true;}
   if(!leaf)return {type:typeName(type),rendered:await serverTreeSnapshot(rendered,normalize,depth+1)};
  }
  return {type:typeName(type),props:await snapshotObject(props,normalize,depth)};
 }
 if(typeof node==='object')return snapshotObject(node as Record<string,unknown>,normalize,depth);
 return String(node);
}

async function snapshotObject(value:Record<string,unknown>,normalize:Normalize,depth:number){
 const out:Record<string,unknown>={};
 for(const key of Object.keys(value).sort())out[key]=normalize(key,await serverTreeSnapshot(value[key],normalize,depth+1));
 return out;
}

/** Every server component (async function component) the snapshot rendered, by name, in render order. */
export function renderedServerComponents(snapshot:unknown,out:string[]=[]):string[]{
 if(Array.isArray(snapshot)){for(const child of snapshot)renderedServerComponents(child,out);return out;}
 if(snapshot&&typeof snapshot==='object'){
  const node=snapshot as Record<string,unknown>;
  if(typeof node.type==='string'&&'rendered' in node)out.push(node.type);
  for(const value of Object.values(node))renderedServerComponents(value,out);
 }
 return out;
}
