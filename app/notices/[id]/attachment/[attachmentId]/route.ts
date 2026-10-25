import {getSession} from '@/lib/session';
import {getNoticeAttachment} from '@/core/notice';
/** Reauthorize every download, including an old link after content changes, expiry or revocation. */
export async function GET(_request:Request,{params}:{params:Promise<{id:string;attachmentId:string}>}){
 const ctx=await getSession(),{id,attachmentId}=await params,asset=await getNoticeAttachment(ctx,id,attachmentId);
 if(!asset)return new Response('Not found',{status:404,headers:{'Cache-Control':'private, no-store'}});
 const safe=asset.fileName.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,120)||'document';
 const encoded=encodeURIComponent(asset.fileName).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 const bytes=new Uint8Array(asset.content);
 return new Response(bytes,{headers:{'Content-Type':asset.mimeType,'Content-Length':String(bytes.byteLength),'Content-Disposition':`attachment; filename="${safe}"; filename*=UTF-8''${encoded}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});
}
