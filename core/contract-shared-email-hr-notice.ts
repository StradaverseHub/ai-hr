/** Fixed native email-document action notices. This boundary never constructs authored executors. */
import {sql} from 'drizzle-orm';
import type {SqlExecutor} from '../db/sql-executor';
import {queueAutomationEmailTx} from './automation-email-delivery';
type NoticePage={letterId:string;signingRevision:number;recipients:{userId:string;personId:string;stepId:string}[]};
export async function deliverContractEmailDocumentHRNotice(db:SqlExecutor,caseId:string){
 const[row]=await db.execute<{page:NoticePage}>(sql`select app.contract_shared_email_hr_notice_page(${caseId}::uuid) as page`);
 if(!row?.page||row.page.recipients.length>30)throw Error('The fixed HR notice source is unavailable.');
 for(const recipient of row.page.recipients)await queueAutomationEmailTx(db,{module:'contract_staff',subjectId:caseId,
  key:`email-hr:${row.page.letterId}:${row.page.signingRevision}:${recipient.userId}:${recipient.personId}`,
  to:[recipient.userId],cc:[],subject:'Contract document needs your action',body:'A Contract document is waiting for your action.\n\n{{case.link}}'});
}
