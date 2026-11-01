/** Resolve async server elements before a Node/DOM test renderer takes over. Leave client components
 * intact so React still owns their hooks, events and providers; do not bypass the real route wrapper. */
import {cloneElement,isValidElement,type ReactNode} from 'react';
export async function resolveRouteServerTree(node:ReactNode):Promise<ReactNode>{
 const settled=await node;
 if(Array.isArray(settled))return Promise.all(settled.map(resolveRouteServerTree));
 if(!isValidElement<{children?:ReactNode}>(settled))return settled;
 if(typeof settled.type==='function'&&settled.type.constructor.name==='AsyncFunction'){
  const server=settled.type as (props:unknown)=>Promise<ReactNode>;
  return resolveRouteServerTree(await server(settled.props));
 }
 return 'children' in settled.props?cloneElement(settled,{children:await resolveRouteServerTree(settled.props.children)}):settled;
}
