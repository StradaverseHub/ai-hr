import {EmployeeChoiceInputError} from './employee-choice';
type BulkPickerRequest={operation:'page'|'all';query:string;offset:number}|{operation:'resolve';picked:string[];raw:string};
/** Bulk selection IDs may exceed a navigation request's 16KB, while labels stay paged.
 * Byte-bound before JSON decoding; no caller can post a tenant, role, or population. */
export async function bulkEmployeePickerRequest(request:Request):Promise<BulkPickerRequest>{
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||!request.body)throw new EmployeeChoiceInputError();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1048576){await reader.cancel();throw new EmployeeChoiceInputError();}chunks.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let data:unknown;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new EmployeeChoiceInputError();}
 if(!data||typeof data!=='object'||Array.isArray(data))throw new EmployeeChoiceInputError();
 const value=data as Record<string,unknown>;
 if(value.operation==='resolve'){
  if(Object.keys(value).some(key=>!['operation','picked','raw'].includes(key))||!Array.isArray(value.picked)||value.picked.some(id=>typeof id!=='string')||typeof value.raw!=='string')throw new EmployeeChoiceInputError();
  return {operation:'resolve',picked:value.picked as string[],raw:value.raw};
 }
 if(!['page','all'].includes(String(value.operation))||Object.keys(value).some(key=>!['operation','query','offset'].includes(key))
  ||typeof value.query!=='string'||value.query.length>200||!Number.isSafeInteger(value.offset)||Number(value.offset)<0)throw new EmployeeChoiceInputError();
 return {operation:value.operation as 'page'|'all',query:value.query,offset:value.offset as number};
}
