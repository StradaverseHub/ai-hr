import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {readLetterAsset} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'self'"};
export async function GET(_request:Request,context:{params:Promise<{assetId:string}>}){
 try{const {assetId}=await context.params,ctx=await getSession(),asset=await readLetterAsset(ctx,assetId),content=new Uint8Array(asset.content);return new Response(content,{headers:{...headers,'content-type':'image/png','content-length':String(content.byteLength),'content-disposition':'inline; filename="letter-asset.png"'}});}
 catch(error){return new Response(null,{status:error instanceof AuthRequiredError?401:error instanceof LetterWorkflowError?404:503,headers});}
}
