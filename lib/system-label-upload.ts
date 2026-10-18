import { LABEL_WORKBOOK_MAX_BYTES } from './system-label-workbook';
/** A workbook plus a bounded multipart/token envelope; file admission is independently checked. */
export const LABEL_UPLOAD_REQUEST_MAX_BYTES=LABEL_WORKBOOK_MAX_BYTES+200_000;
export async function readLabelUploadRequest(request:Request):Promise<{ok:true;data:FormData}|{ok:false;error:string;status:number}>{
  const reader=request.body?.getReader(),contentType=request.headers.get('content-type');
  if(!reader||!contentType?.startsWith('multipart/form-data'))return {ok:false,error:'invalid',status:400};
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;
      if(size>LABEL_UPLOAD_REQUEST_MAX_BYTES){await reader.cancel();return {ok:false,error:'tooLarge',status:413};}chunks.push(chunk.value);}
    const data=await new Response(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))),{headers:{'Content-Type':contentType}}).formData();
    return {ok:true,data};
  }catch{return {ok:false,error:'invalid',status:400};}
}
