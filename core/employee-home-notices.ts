/** Own employment is selected before the canonical Notice reader; HR reach is never self-service reach. */
import type {SessionContext} from '../db/client';
import {requireOwnHomeSubject} from './employee-home';
import {employeeNoticeBoard,employeeNoticeById} from './notice';

export async function readOwnNoticeBoard(ctx:SessionContext,employmentId:string,options:Parameters<typeof employeeNoticeBoard>[2]={}){
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 return employeeNoticeBoard(ctx,subject.employmentId,options);
}
export async function readOwnNotice(ctx:SessionContext,employmentId:string,id:string){
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 return employeeNoticeById(ctx,subject.employmentId,id);
}

/** Home consumes five current summaries with exact full-population counts from the Notice owner.
 * Full content and explicit version acknowledgement remain in its existing reader and writer. */
export async function readEmployeeHomeNotices(ctx:SessionContext,employmentId:string):Promise<import('../lib/employee-home-read-model').EmployeeHomeNotices>{
 const value=await readOwnNoticeBoard(ctx,employmentId,{page:1,pageSize:5});
 return {version:1,employmentId,total:value.total,unread:value.unread,acknowledgementRequired:value.acknowledgementRequired,
  items:value.items.map(row=>({id:row.id,title:row.title,summary:row.summary,category:row.category,pinned:row.pinned,
   requiresAcknowledgement:row.requiresAcknowledgement,publishedAt:row.publishedAt?.toISOString()??null,publishedBy:row.publishedBy,
   firstViewedAt:row.firstViewedAt?.toISOString()??null,acknowledgedAt:row.acknowledgedAt?.toISOString()??null}))};
}
