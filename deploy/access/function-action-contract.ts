/** Installation-owned descriptors. A descriptor is not an enforcement attestation: publication
 * additionally verifies its actual SQL owners and the module's completion prerequisite. */
export const FUNCTION_OPERATIONS=['view','add','edit','delete','approve','issue','execute'] as const;
export type FunctionOperation=typeof FUNCTION_OPERATIONS[number];
export type FunctionActionDescriptor={
 key:string;scope:'tenant'|'company';moduleKey:string;labelKey:string;
 kind:'screen'|'submenu'|'native_acl';course:'administrative'|'own'|'assigned';
 screenKey?:string;href?:string;employeeBearing?:boolean;
 actions:readonly {operation:FunctionOperation;parentCapability?:string|null;delegationFloorFunction?:string|null;
  bindings:readonly {owner:string;operation:string}[]}[];
};
export function functionCapabilityId(key:string,operation:FunctionOperation){
 if(!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(key)||key.length>160)throw new Error('Invalid code-owned function key');
 return `function.${key}.${operation}`;
}
export function functionActionCapabilities(descriptors:readonly FunctionActionDescriptor[]){
 const keys=new Set<string>();
 return descriptors.flatMap(descriptor=>{
  if(keys.has(descriptor.key))throw new Error('Duplicate function descriptor');keys.add(descriptor.key);
  const operations=descriptor.actions.map(action=>action.operation);
  if(!operations.includes('view')||new Set(operations).size!==operations.length)throw new Error('Function requires one View action');
  return descriptor.actions.map(action=>{
   if(!action.bindings.length)throw new Error('Function action requires actual owner bindings');
   return {id:functionCapabilityId(descriptor.key,action.operation),scope:descriptor.scope,bindings:action.bindings,
    prerequisites:[...(action.parentCapability?[action.parentCapability]:[]),...(action.operation==='view'?[]:[functionCapabilityId(descriptor.key,'view')])],
    presentation:{key:descriptor.key,moduleKey:descriptor.moduleKey,labelKey:descriptor.labelKey,kind:descriptor.kind,course:descriptor.course,...(descriptor.employeeBearing===undefined?{}:{employeeBearing:descriptor.employeeBearing}),...(descriptor.screenKey?{screenKey:descriptor.screenKey}:{}),...(descriptor.href?{href:descriptor.href}:{})}};
  });
 });
}
