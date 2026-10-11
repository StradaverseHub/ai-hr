import 'server-only';
import { request } from 'node:http';
import { EmailSettingsError, emailFailureCodes, type EmailSettingsRequest } from './email-model';
/** Unix socket permission is the transport boundary; the service rechecks the exact enrolled identity. */
export async function identityEmailRequest<T>(body: EmailSettingsRequest): Promise<T> {
  return new Promise((resolve,reject) => {
    const req=request({socketPath:process.env.IDENTITY_EMAIL_SOCKET || '/run/aihr-identity-email.sock',path:'/v1/settings',method:'POST',
      headers:{'content-type':'application/json'},timeout:35_000}, res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>65536){res.destroy();reject(new EmailSettingsError('unavailable'));}else chunks.push(chunk);});
      res.on('error',()=>reject(new EmailSettingsError('unavailable')));
      res.on('end',()=>{try {
        const value=JSON.parse(Buffer.concat(chunks).toString());
        if(res.statusCode!==200){const code=emailFailureCodes.includes(value?.error) ? value.error : 'unavailable';reject(new EmailSettingsError(code));}
        else resolve(value as T);
      }catch{reject(new EmailSettingsError('unavailable'));}});
    });
    req.on('timeout',()=>req.destroy());req.on('error',()=>reject(new EmailSettingsError('unavailable')));
    req.end(JSON.stringify(body));
  });
}
