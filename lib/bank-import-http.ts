import {BankImportJobError} from '../core/bank-import-job';
export function assertBankImportOrigin(request:Request){
 const origin=request.headers.get('origin'),host=request.headers.get('x-forwarded-host')??request.headers.get('host');
 try{if(origin&&host&&new URL(origin).host===host)return;}catch{}
 throw new BankImportJobError('Import request refused.',403);
}
export async function bankImportBody(request:Request,max:number){
 if(Number(request.headers.get('content-length'))>max)throw new BankImportJobError('Upload part is too large.',413);
 if(!request.body)throw new BankImportJobError('Missing upload data.');
 const reader=request.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
 try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>max){await reader.cancel();throw new BankImportJobError('Upload part is too large.',413);}parts.push(r.value);}return Buffer.concat(parts);}
 finally{reader.releaseLock();}
}
export function bankImportHttpError(error:unknown){
 if(error instanceof BankImportJobError)return Response.json({error:error.message},{status:error.status,headers:{'Cache-Control':'private, no-store'}});
 // Never surface raw SQL or cell values. The client can retry its same job/part safely.
 return Response.json({error:'The import request could not be completed. Reopen its progress before retrying.'},{status:500,headers:{'Cache-Control':'private, no-store'}});
}
