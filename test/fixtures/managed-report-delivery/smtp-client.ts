/** Disposable transport-only child: authorization is covered by the installed-service fixture. */
import {readFile} from 'node:fs/promises';
import {sendEmployeeMasterSmtp} from '../../../deploy/identity-email/smtp';
import {notificationSmtpFailure} from '../../../lib/notification-email-model';
import {defaultEmailConfig} from '../../../lib/identity/email-model';
import type {MasterDeliveryTarget} from '../../../deploy/identity-email/reports';
async function main(){
 try{
  const bytes=await readFile(process.argv[3]);
  await sendEmployeeMasterSmtp({...defaultEmailConfig,host:'127.0.0.1',port:Number(process.argv[2]),from:'owner@report-acceptance.invalid',auth:false},undefined,
   {email:'recipient@report-acceptance.invalid',locale:'en'} as MasterDeliveryTarget,
   {bytes,filename:'Employee-Master.xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',rowCount:1,scopeIds:[]},'<employee-master-transport-fixture@report-acceptance.invalid>');
  console.log(JSON.stringify({outcome:'sent'}));
 }catch(error){console.log(JSON.stringify(notificationSmtpFailure(error)));}
}
main().then(()=>process.exit(0),()=>process.exit(1));
