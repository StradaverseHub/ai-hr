import {getSession} from '@/lib/session';
import {readProfileAttachment} from '@/core/profile-attachments';
import {EssProfileError} from '@/lib/personnel-ess-model';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 try{const file=await readProfileAttachment(await getSession(),(await params).id);return new Response(new Uint8Array(file.content),{headers:{'Content-Type':file.mimeType,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
 catch(error){if(error instanceof EssProfileError)return new Response(null,{status:404});throw error;}
}
