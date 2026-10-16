import {request} from 'node:http';
import {masterDeliveryRequest,type MasterDeliveryRequest} from './employee-master-delivery-model';
export function employeeMasterDeliverySocket(env:Record<string,string|undefined>=process.env){
 return env.AUTH_PROVIDER==='internal'?'/run/aihr-internal-report.sock':env.IDENTITY_EMAIL_SOCKET||'/run/aihr-identity-email.sock';
}
/** No caller-selected address, message, workbook bytes or transport configuration is accepted. */
export function employeeMasterDeliveryIpc<T>(input:MasterDeliveryRequest):Promise<T> {
 const body=masterDeliveryRequest.parse(input);
 return new Promise((resolve,reject)=>{
  const req=request({socketPath:employeeMasterDeliverySocket(),path:'/v1/reports',method:'POST',headers:{'content-type':'application/json'},timeout:process.env.AUTH_PROVIDER==='internal'?240_000:180_000},res=>{
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4096)res.destroy(new Error('Report delivery response is invalid.'));else chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error();resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);}catch{reject(new Error('Managed report delivery is unavailable.'));}});
  });
  req.on('timeout',()=>req.destroy(new Error('Managed report delivery is unavailable.')));req.on('error',reject);req.end(JSON.stringify(body));
 });
}
