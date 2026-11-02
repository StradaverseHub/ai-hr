import {requireModule} from '@/lib/authz';
import {downloadProbationFile} from '@/packs/probation/service';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
export async function GET(_request:Request,{params}:{params:Promise<{id:string;fileId:string}>}){
 const ctx=await requireModule('lifecycle'),{id,fileId}=await params;
 try{const file=await downloadProbationFile(ctx,id,fileId),name=encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16));return new Response(new Uint8Array(file.content),{headers:{...headers,'content-type':file.mimeType,'content-disposition':`attachment; filename*=UTF-8''${name}`,'content-length':String(file.content.byteLength)}});}catch{return new Response(null,{status:404,headers});}
}
