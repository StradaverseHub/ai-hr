import {getSession} from '@/lib/session';
import {createMyLetterAccess,downloadMyLetter} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {AuthRequiredError} from '@/lib/auth-errors';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
export async function GET(request:Request,context:{params:Promise<{letterId:string}>}){
 const {letterId}=await context.params,url=new URL(request.url);
 try{const ctx=await getSession(),document=await downloadMyLetter(ctx,{letterId,token:url.searchParams.get('token')??''}),content=new Uint8Array(document.content);return new Response(content,{headers:{...headers,'content-type':'application/pdf','content-length':String(content.byteLength),'content-disposition':`${url.searchParams.get('inline')==='1'?'inline':'attachment'}; filename="${document.fileName}"`}});}catch(error){if(error instanceof AuthRequiredError)return new Response(null,{status:401,headers});if(error instanceof LetterWorkflowError)return new Response(null,{status:404,headers});throw error;}
}

// Keep PDF navigation outside the page's Server Action queue. Both requests still check ownership.
export async function POST(request:Request,context:{params:Promise<{letterId:string}>}){
 const site=request.headers.get('sec-fetch-site');
 if(!isSameOriginBrowserRequest(request)||(site!==null&&site!=='same-origin'))return new Response(null,{status:403,headers});
 const {letterId}=await context.params;
 const redirect=(location:string)=>new Response(null,{status:303,headers:{...headers,location}});
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(letterId)){
  return redirect('/me/letters?error=invalid');
 }
 const path='/me/letters/'+letterId;
 try{
  const ctx=await getSession();
  const {token}=await createMyLetterAccess(ctx,letterId);
  const inline=new URL(request.url).searchParams.get('inline')==='1'?'1':'0';
  return redirect(path+'/document?'+new URLSearchParams({token,inline}));
 }catch(error){
  if(error instanceof AuthRequiredError)return new Response(null,{status:401,headers});
  return redirect(path+'?error='+encodeURIComponent(error instanceof LetterWorkflowError?error.code:'unavailable'));
 }
}
