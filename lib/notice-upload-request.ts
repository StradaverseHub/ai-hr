/** Bound request bytes before multipart parsing; the server-action default is below the Notice file cap. */
export class NoticeUploadRequestError extends Error {
 constructor(readonly status:number,readonly reason:'file'|'tooLarge'|'unavailable'){super(reason);}
}
export function noticeUploadSameOrigin(request:Request):boolean{
 const raw=request.headers.get('origin');if(!raw)return false;
 try{const origin=new URL(raw),host=request.headers.get('x-forwarded-host')??request.headers.get('host')??new URL(request.url).host;
  return ['http:','https:'].includes(origin.protocol)&&origin.origin===raw&&origin.host===host;
 }catch{return false;}
}
export async function readNoticeUploadRequest(request:Request,maxFileBytes:number):Promise<FormData>{
 const maxBytes=maxFileBytes+65536,type=request.headers.get('content-type');
 if(!type?.toLowerCase().startsWith('multipart/form-data;')||!request.body)throw new NoticeUploadRequestError(400,'file');
 const length=request.headers.get('content-length');
 if(length&&(!/^\d+$/.test(length)||Number(length)>maxBytes))throw new NoticeUploadRequestError(413,'tooLarge');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
  if(total>maxBytes){await reader.cancel();throw new NoticeUploadRequestError(413,'tooLarge');}chunks.push(value);
 }}finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return await new Response(bytes,{headers:{'Content-Type':type}}).formData();}catch{throw new NoticeUploadRequestError(400,'file');}
}
