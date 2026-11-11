import {capacityAwareRoute} from '@/lib/database-degraded';
import {isDatabaseCapacityFailure} from '@/db/read-retry';
import {parsePersonnelColumnFilters} from '@/lib/personnel-list-controls';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {requireWorkforceAccess} from '@/lib/workforce-authz';
import {createPersonnelPrivateSearch,PersonnelSearchLimitError} from '@/core/personnel-private-search';
import {parsePageQuery} from '@/lib/pagination';
import {personnelQueryParams,type PersonnelSearchParams} from '../list-query';
export const POST = capacityAwareRoute(async function POST(request: Request) {
 return searchPersonnel(request);
});

function searchFailure(status:400|500,message='Search unavailable. Try again.'){
 return new Response(message,{status,headers:{'Cache-Control':'private, no-store'}});
}

async function searchPersonnel(request: Request) {
 if(!isSameOriginBrowserRequest(request))return new Response('Forbidden',{status:403});
 if(Number(request.headers.get('content-length'))>131072)return new Response('Search unavailable.',{status:413});
 const {s,scopeIds}=await requireWorkforceAccess({ personnelList: true });
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded'))return new Response('Search unavailable.',{status:415});
 const reader=request.body?.getReader();if(!reader)return new Response('Search unavailable.',{status:400});
 const decoder=new TextDecoder(),parts:string[]=[];let bytes=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>131072){await reader.cancel();return new Response('Search unavailable.',{status:413});}parts.push(decoder.decode(chunk.value,{stream:true}));}parts.push(decoder.decode());}finally{reader.releaseLock();}
 const form=new URLSearchParams(parts.join('')),params:PersonnelSearchParams={};
 for(const key of ['companies','bu','parent','group','grade','position','quality','dept','type','bucket','status','company','confirmation','joinedFrom','joinedTo','probationFrom','probationTo','sort','direction'] as const){const values=form.getAll(key).filter((value):value is string=>typeof value==='string');if(values.length)Object.assign(params,{[key]:['companies','bu','parent','group','grade','position','quality'].includes(key)&&values.length>1?values:values[0]});}
 let filters:ReturnType<typeof parsePersonnelColumnFilters>;
 try{filters=parsePersonnelColumnFilters(form).filter(filter=>filter.field!==form.get('removeField'));}
 catch(error){return searchFailure(error instanceof Error&&error.constructor===Error?400:500);}
 const text=form.get('removeField')==='term'?'':String(form.get('term')??'').trim();
 if(text.length>200)return searchFailure(400);
 const target=personnelQueryParams(params);
 if(form.has('size'))target.set('size',String(parsePageQuery({size:form.get('size')??undefined}).size));
 try{
  if(text||filters.length){const token=await createPersonnelPrivateSearch(s,{text,companyIds:scopeIds,columnFilters:filters,replaceCriteria:true});target.set('search',token);}
 }
 catch(error){if(isDatabaseCapacityFailure(error))throw error;return error instanceof PersonnelSearchLimitError?searchFailure(400,error.message):searchFailure(500);}
 const href='/admin/personnel'+(target.size?'?'+target.toString():'');
 const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'};
 if(request.headers.get('accept')==='application/json')return Response.json({href},{headers});
 return new Response(null,{status:303,headers:{...headers,Location:href}});
}
