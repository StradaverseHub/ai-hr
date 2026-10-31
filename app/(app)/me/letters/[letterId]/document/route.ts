import {getSession} from '@/lib/session';
import {downloadMyLetter} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {AuthRequiredError} from '@/lib/auth-errors';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
export async function GET(request:Request,context:{params:Promise<{letterId:string}>}){
 const {letterId}=await context.params,url=new URL(request.url);
 try{const ctx=await getSession(),document=await downloadMyLetter(ctx,{letterId,token:url.searchParams.get('token')??''}),content=new Uint8Array(document.content);return new Response(content,{headers:{...headers,'content-type':'application/pdf','content-length':String(content.byteLength),'content-disposition':`${url.searchParams.get('inline')==='1'?'inline':'attachment'}; filename="${document.fileName}"`}});}catch(error){if(error instanceof AuthRequiredError)return new Response(null,{status:401,headers});if(error instanceof LetterWorkflowError)return new Response(null,{status:404,headers});throw error;}
}
