import {unstable_rethrow} from 'next/navigation';
import {getLocale,getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {escapeFormHtml as esc,hiddenFormField as hidden,NativeFormError,readNativeUrlForm} from '@/lib/native-form';
import {BodyReadError} from '@/lib/bounded-body';
import {currentUiTheme} from '@/lib/ui-theme-server';
import {withTenant} from '@/db/client';
import {assertAiPresentationPrincipalTx} from '@/core/ai-principal';
import {AiGatewayError} from '@/lib/ai/types';
import {isAdmin} from '@/lib/authz-model';
import {analyticsManagerSelection} from '@/core/analytics';
import {readEmployeeChoices,EmployeeChoiceAccessError,EmployeeChoiceInputError} from '@/core/employee-choice';

export const runtime='nodejs';
const action='/analytics/manager-choices';
const headers={
 'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','Content-Type':'text/html; charset=utf-8',
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'",
};
// Report fields are opaque navigation state, never employee-choice population authority.
const reportKeys=['companyId','departmentId','costCenterId','lifecycleStatus','assignmentStatus','gender','nationality','workState','from','to','q','year','hirePage','hireSize','termPage','termSize','changePage','changeSize','carryPage','carrySize'] as const;
const allowed=new Set<string>([...reportKeys,'managerEmploymentId','managerQuery','offset','stage','choiceContext']);
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function text(data:FormData,key:string,maximum=1024){
 const value=data.get(key);if(value===null)return '';
 if(typeof value!=='string'||value.length>maximum||value.includes('\0'))throw new NativeFormError('Invalid field');
 return value;
}
function reportQuery(data:FormData,selectedId:string){
 const query=new URLSearchParams();
 for(const key of reportKeys)if(data.has(key))query.set(key,text(data,key));
 if(selectedId)query.set('managerEmploymentId',selectedId);
 return query;
}
function documentHtml(locale:string,theme:string,title:string,back:string,backLabel:string,body:string){
 return `<!doctype html><html lang="${esc(locale)}" data-ui-theme="${esc(theme)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>body{font:1rem/1.5 system-ui,sans-serif;margin:2rem auto;padding:0 1rem;max-width:48rem;color:CanvasText;background:Canvas;color-scheme:light dark}label{display:block;margin:1rem 0 .25rem}button,input,select{font:inherit;padding:.5rem;max-width:100%}select{display:block;width:100%}nav{display:flex;gap:1rem;margin:1rem 0}html[data-ui-theme="classic"] button{border-radius:.5rem}html[data-ui-theme="monolith"] button{border-radius:0}</style></head><body><header><a href="${esc(back)}">${esc(backLabel)}</a><h1>${esc(title)}</h1></header>${body}</body></html>`;
}

/** A native, side-effect-free read flow. Search is only in bounded POST bodies; only Apply redirects. */
export async function POST(request:Request){
 const site=request.headers.get('sec-fetch-site');
 if(!isSameOriginBrowserRequest(request)||site!==null&&site!=='same-origin'||request.headers.has('authorization'))return new Response('Forbidden',{status:403,headers});
 if(new URL(request.url).search)return new Response('Invalid request',{status:400,headers});
 // Keep login expiry and non-admin framework redirects intact. A scope storage failure is unavailable.
 let context:Awaited<ReturnType<typeof scopedAdmin>>;
 try{context=await scopedAdmin();}catch(error){unstable_rethrow(error);return new Response('Unavailable',{status:503,headers});}
 const {s,scopeIds}=context;
 let presentation: [Awaited<ReturnType<typeof getTranslations<'employeePanel'>>>,Awaited<ReturnType<typeof getTranslations<'analytics'>>>,string,Awaited<ReturnType<typeof currentUiTheme>>];
 try{presentation=await Promise.all([getTranslations('employeePanel'),getTranslations('analytics'),getLocale(),currentUiTheme()]);}
 catch(error){unstable_rethrow(error);return new Response('Unavailable',{status:503,headers});}
 const [t,a,locale,theme]=presentation;
 let back='/analytics';
 const render=(body:string,status=200)=>new Response(documentHtml(locale,theme,a('filterManager'),back,a('title'),body),{status,headers});
 const failure=(status:number)=>render(`<p role="alert">${esc(t('loadFailed'))}</p>`,status);
 try{
  const data=await readNativeUrlForm(request,16384,allowed);
  // Initial button-only context preserves year/pagers/q. Current editable form controls win.
  if(data.has('choiceContext')){
   let context:unknown;try{context=JSON.parse(text(data,'choiceContext',8192));}catch{throw new NativeFormError('Invalid context');}
   if(!context||typeof context!=='object'||Array.isArray(context))throw new NativeFormError('Invalid context');
   for(const [key,value] of Object.entries(context)){
    if(!reportKeys.includes(key as typeof reportKeys[number])||typeof value!=='string'||value.length>1024||value.includes('\0'))throw new NativeFormError('Invalid context');
    if(!data.has(key))data.set(key,value);
   }
  }
  for(const key of reportKeys)text(data,key);
  const rawSelectedId=text(data,'managerEmploymentId',36),query=text(data,'managerQuery',1000);
  if(rawSelectedId&&!uuid.test(rawSelectedId))throw new NativeFormError('Invalid selection');
  // Analytics bookmarks already accept UUID hex in either case. PostgreSQL
  // returns canonical lower-case IDs; use that representation throughout.
  const selectedId=rawSelectedId.toLowerCase();
  const stage=text(data,'stage',10)||'browse';
  const raw=text(data,'offset',16)||'0',offset=Number(raw);
  if(!['browse','apply'].includes(stage)||!/^\d+$/.test(raw)||!Number.isSafeInteger(offset)||offset<0||offset>Number.MAX_SAFE_INTEGER-25)throw new NativeFormError('Invalid controls');
  back='/analytics?'+reportQuery(data,selectedId);
  if(!isAdmin(s))return failure(403);
  // Even clearing to All must prove the native login is still current, without a workforce count.
  await withTenant(s,tx=>assertAiPresentationPrincipalTx(tx,s),{readOnlySnapshot:true,readSignal:request.signal});
  const selected=selectedId?await analyticsManagerSelection(s,scopeIds,selectedId):null;
  if(selectedId&&(!selected||selected.employmentId!==selectedId))return failure(403);
  if(stage==='apply')return new Response(null,{status:303,headers:{...headers,Location:back}});
  const page=await readEmployeeChoices(s,{query,offset,limit:25,labelMode:'names',selectedId:selectedId||undefined,companyIds:scopeIds},request.signal);
  const fields=reportKeys.filter(key=>data.has(key)).map(key=>hidden(key,text(data,key))).join('');
  const pinned=selected&&!page.rows.some(row=>row.employmentId===selectedId)?`<option value="${esc(selectedId)}" selected>${esc(selected.name)}</option>`:'';
  const options=page.rows.map(row=>`<option value="${esc(row.employmentId)}"${row.employmentId===selectedId?' selected':''}>${esc(row.name)}</option>`).join('');
  return render(`<form method="post" action="${action}">${fields}<label for="manager-query">${esc(t('searchLabel'))}</label><input type="search" id="manager-query" name="managerQuery" value="${esc(query)}" placeholder="${esc(t('searchPlaceholder'))}"><button type="submit" name="offset" value="0">${esc(t('searchLabel'))}</button><label for="manager-choice">${esc(a('filterManager'))}</label><select id="manager-choice" name="managerEmploymentId"><option value=""${!selectedId?' selected':''}>${esc(a('allManagers'))}</option>${pinned}${options}</select><p>${esc(t('pageRange',{from:page.rows.length?offset+1:0,to:page.rows.length?offset+page.rows.length:0,total:page.total}))}</p>${page.rows.length?'':`<p>${esc(t('noEmployees'))}</p>`}<nav><button type="submit" name="offset" value="${Math.max(0,offset-25)}"${offset===0?' disabled':''}>${esc(t('previousPage'))}</button><button type="submit" name="offset" value="${offset+25}"${offset+page.rows.length>=page.total?' disabled':''}>${esc(t('nextPage'))}</button></nav><button type="submit" name="stage" value="apply">${esc(a('apply'))}</button></form>`);
 }catch(error){
  unstable_rethrow(error);
  if(request.signal.aborted)throw error;
  if(error instanceof NativeFormError||error instanceof BodyReadError||error instanceof EmployeeChoiceInputError)return failure(400);
  if(error instanceof AiGatewayError||error instanceof EmployeeChoiceAccessError||error instanceof Error&&error.message==='Forbidden')return failure(403);
  return failure(503);
 }
}
