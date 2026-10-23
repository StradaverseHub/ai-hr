import {attendanceCcTarget,type AttendanceCcTarget} from '../../lib/attendance-cc-mail';
import {notificationEmailLink,notificationSmtpFailure,type NotificationEmailOutcome,type NotificationEmailError} from '../../lib/notification-email-model';
import type {WorkflowMail,WorkflowMailTarget} from './notifications';
export type AttendanceCcDeliveryPorts={
 target(id:string,token:string):Promise<unknown>;
 start(id:string,token:string,target:AttendanceCcTarget):Promise<boolean>;
 finish(id:string,token:string,outcome:NotificationEmailOutcome,error:NotificationEmailError|null):Promise<boolean>;
};
export async function deliverAttendanceCc(id:string,token:string,d:{origin:string;ready():Promise<boolean>;verifyRecipient(target:WorkflowMailTarget):Promise<'verified'|'changed'|'unavailable'>;send(target:WorkflowMailTarget,mail:WorkflowMail):Promise<void>;cc:AttendanceCcDeliveryPorts}) {
 if(!await d.ready())return{outcome:'unavailable' as const};
 const parsed=attendanceCcTarget.safeParse(await d.cc.target(id,token));
 if(!parsed.success){await d.cc.finish(id,token,'skipped','notEligible');return{outcome:'skipped' as const};}
 const target=parsed.data,recipient:WorkflowMailTarget={user_id:target.userId??'',subject:target.subject??'',email:target.email,category:'attendance',link_path:`/attendance/application-history/${target.message.reference}`,severity:'info',locale:target.locale};
 const link=notificationEmailLink(d.origin,recipient.link_path);
 if(target.kind==='employee'){
  const verified=await d.verifyRecipient(recipient);
  if(verified==='unavailable')return{outcome:'unavailable' as const};
  if(verified!=='verified'){await d.cc.finish(id,token,'skipped','recipientChanged');return{outcome:'skipped' as const};}
 }
 // The private database rechecks the complete target, policy/consent and lease immediately before SMTP.
 if(!await d.cc.start(id,token,target))return{outcome:'busy' as const};
 let outcome:NotificationEmailOutcome='sent',error:NotificationEmailError|null=null;
 try{await d.send(recipient,{category:'attendance',locale:target.locale,link,action:false,messageId:`<attendance-cc-${id}@${new URL(d.origin).hostname}>`,attendanceCc:target.message});}
 catch(cause){({outcome,error}=notificationSmtpFailure(cause));}
 if(!await d.cc.finish(id,token,outcome,error))throw new Error('Attendance CC result could not be recorded');
 return{outcome};
}
