import assert from 'node:assert/strict';

const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);

/** Only compiled route templates leave the collector. Concrete record paths never enter a receipt. */
export function createRouteHandlerInventory(appPathRoutes,routesManifest){
 const registered=[...new Set(Object.entries(appPathRoutes)
  .filter(([entry,path])=>entry.endsWith('/route')&&typeof path==='string'&&path.startsWith('/'))
  .map(([,path])=>path))].sort();
 assert(registered.length>0,'The build recorded no route handlers');
 assert(Array.isArray(routesManifest.dynamicRoutes),'The build recorded no dynamic route manifest');
 const staticPaths=new Set(registered.filter(path=>!path.includes('[')));
 const dynamicPaths=new Set(registered.filter(path=>path.includes('[')));
 const dynamic=routesManifest.dynamicRoutes.filter(route=>dynamicPaths.has(route.page))
  .map(({page,regex})=>({page,pattern:new RegExp(regex)}));
 return {
  registered,
  match(pathname,method){
   if(!methods.has(method))return null;
   const path=pathname.length>1?pathname.replace(/\/$/,''):pathname;
   return staticPaths.has(path)?path:dynamic.find(route=>route.pattern.test(path))?.page??null;
  },
 };
}

/** Count completed successful responses observed inside a successful scripted journey. */
export function successfulHandlerReceipts(rows){
 return [...rows].filter(row=>Number.isSafeInteger(row.status)&&row.status>=200&&row.status<300
  &&Number.isSafeInteger(row.completionMs)&&row.completionMs>=0)
  .map(({template,method,status,completionMs})=>({template,method,status,completionMs}));
}
