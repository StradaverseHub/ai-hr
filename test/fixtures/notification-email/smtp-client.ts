/** Child-process fixture so Node reads NODE_EXTRA_CA_CERTS at startup; never a real relay or recipient. */
import { sendWorkflowSmtp } from '../../../deploy/identity-email/smtp';
import { notificationSmtpFailure } from '../../../lib/notification-email-model';
import { defaultEmailConfig } from '../../../lib/identity/email-model';
async function main(){
 try{
  await sendWorkflowSmtp({...defaultEmailConfig,host:'localhost',port:Number(process.argv[2]),from:'hr@example.test',auth:false},undefined,
   {user_id:'fixture',subject:'fixture',email:'employee@example.test',category:'payroll',link_path:'/me',severity:'info',locale:'en'},
   {category:'payroll',locale:'en',link:'https://hr.example.test/me',action:false,messageId:'<notification-fixture@hr.example.test>'});
  console.log(JSON.stringify({outcome:'sent'}));
 }catch(e){console.log(JSON.stringify(notificationSmtpFailure(e)));}
}
main().then(()=>process.exit(0),()=>process.exit(1));
