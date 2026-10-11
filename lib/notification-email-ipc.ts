import { request } from 'node:http';
import { notificationEmailRequest, type NotificationEmailRequest } from './notification-email-model';
/** Credentials remain in the root-installed service. Jobs carry only an ID and a lease capability. */
export function notificationEmailIpc<T>(input:NotificationEmailRequest):Promise<T> {
  const body=notificationEmailRequest.parse(input);
  return new Promise((resolve,reject)=>{
    const req=request({socketPath:process.env.IDENTITY_EMAIL_SOCKET||'/run/aihr-identity-email.sock',path:'/v1/notifications',method:'POST',headers:{'content-type':'application/json'},timeout:35_000},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4096)res.destroy(new Error('Invalid workflow email response'));else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('Workflow email service unavailable');resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);}catch{reject(new Error('Workflow email service unavailable'));}});
    });
    req.on('timeout',()=>req.destroy(new Error('Workflow email service unavailable')));req.on('error',reject);req.end(JSON.stringify(body));
  });
}
