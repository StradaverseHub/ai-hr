/** Resolves a React Server Component tree for tests that render it with react-dom (which cannot await an async
 * component): every async function component is called and awaited, and every Suspense boundary is replaced by its
 * resolved children, so the test sees what the streamed page finally shows. Synchronous components (client or
 * server) are left for the renderer; only their element-valued props are walked. Framework-free. */
import {Fragment,Suspense,createElement,isValidElement,type ReactElement,type ReactNode} from 'react';

const isAsync=(value:unknown):value is (props:unknown)=>Promise<ReactNode>=>typeof value==='function'&&value.constructor?.name==='AsyncFunction';

async function resolveValue(value:unknown):Promise<unknown>{
 if(Array.isArray(value))return Promise.all(value.map(resolveValue));
 if(isValidElement(value))return resolveServerTree(value);
 return value;
}

export async function resolveServerTree(node:ReactNode):Promise<ReactNode>{
 if(Array.isArray(node))return Promise.all(node.map(item=>resolveServerTree(item as ReactNode))) as Promise<ReactNode>;
 if(!isValidElement(node))return node;
 const element=node as ReactElement<Record<string,unknown>>;
 if(element.type===Suspense)return createElement(Fragment,{key:element.key},await resolveServerTree(element.props.children as ReactNode));
 if(isAsync(element.type))return createElement(Fragment,{key:element.key},await resolveServerTree(await element.type(element.props)));
 const props:Record<string,unknown>={};
 for(const [name,value] of Object.entries(element.props))props[name]=await resolveValue(value);
 return createElement(element.type as never,{...props,key:element.key});
}
