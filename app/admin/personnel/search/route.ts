import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {requireWorkforceAccess} from '@/lib/workforce-authz';
import {createPersonnelPrivateSearch,PersonnelSearchLimitError} from '@/core/personnel-private-search';
import {personnelQueryParams,type PersonnelSearchParams} from '../list-query';
export async function POST(request: Request) {
 return searchPersonnel(request);
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
 for(const key of ['companies','bu','parent','group','grade','position','quality','dept','type','bucket','status','company','confirmation','joinedFrom','joinedTo','probationFrom','probationTo'] as const){const values=form.getAll(key).filter((value):value is string=>typeof value==='string');if(values.length)Object.assign(params,{[key]:['companies','bu','parent','group','grade','position','quality'].includes(key)&&values.length>1?values:values[0]});}
 try{const token=await createPersonnelPrivateSearch(s,{text:String(form.get('term')??''),companyIds:scopeIds});const target=personnelQueryParams(params);target.set('search',token);return new Response(null,{status:303,headers:{Location:'/admin/personnel?'+target.toString(),'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});}
 catch(error){return new Response(error instanceof PersonnelSearchLimitError?error.message:'Search unavailable. Try again.',{status:400,headers:{'Cache-Control':'private, no-store'}});}
}
