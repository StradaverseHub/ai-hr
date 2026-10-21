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
