import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {downloadStaffLetter} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
export async function GET(request:Request,context:{params:Promise<{letterId:string}>}){
 const {letterId}=await context.params;
 try{
  const ctx=await getSession(),document=await downloadStaffLetter(ctx,letterId),content=new Uint8Array(document.content),inline=new URL(request.url).searchParams.get('inline')==='1';
  return new Response(content,{headers:{...headers,'content-type':'application/pdf','content-length':String(content.byteLength),'content-disposition':`${inline?'inline':'attachment'}; filename="${document.fileName}"`}});
 }catch(error){
  const status=error instanceof AuthRequiredError?401:error instanceof LetterWorkflowError?404:503;
  return new Response(null,{status,headers});
 }
}
