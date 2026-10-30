/** Public translation data only. These helpers never cache principals, permissions or HR records. */
export type ClientMessages={ [key:string]:string|ClientMessages };
const branch=(value:unknown):value is ClientMessages=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const put=(tree:ClientMessages,key:string,value:string|ClientMessages)=>Object.defineProperty(tree,key,{value,enumerable:true,writable:true,configurable:true});
export function pickClientMessages(messages:ClientMessages,prefixes:readonly string[]|null):ClientMessages{
 if(prefixes===null)return messages;
 const selected=prefixes.filter(value=>!prefixes.some(parent=>parent!==value&&value.startsWith(parent+'.'))),result:ClientMessages={};
 for(const prefix of selected){
  const parts=prefix.split('.');let input:string|ClientMessages=messages;
  for(const part of parts){if(!branch(input)||!Object.hasOwn(input,part))return messages;input=input[part];}
  let output=result;
  for(const part of parts.slice(0,-1)){if(!Object.hasOwn(output,part))put(output,part,{});output=output[part] as ClientMessages;}
  put(output,parts.at(-1)!,input);
 }
 return result;
}
export function additionalClientMessages(messages:ClientMessages,shared:ClientMessages):ClientMessages{
 const result:ClientMessages={};
 for(const [key,value]of Object.entries(messages)){
  const inherited=Object.hasOwn(shared,key)?shared[key]:undefined;
  if(value===inherited)continue;
  if(branch(value)&&branch(inherited)){
   const children=additionalClientMessages(value,inherited);if(Object.keys(children).length)put(result,key,children);
  }else put(result,key,value);
 }
 return result;
}
export function mergeClientMessages(parent:ClientMessages,additional:ClientMessages):ClientMessages{
 if(!Object.keys(additional).length)return parent;
 const result:ClientMessages={...parent};
 for(const [key,value]of Object.entries(additional)){
  const inherited=Object.hasOwn(parent,key)?parent[key]:undefined;
  put(result,key,branch(value)&&branch(inherited)?mergeClientMessages(inherited,value):value);
 }
 return result;
}
