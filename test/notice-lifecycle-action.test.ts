import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createNotice,getNotice} from '../core/notice';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:ReturnType<typeof adminCtx>,redirected='';
vi.mock('../lib/authz',()=>({requireAdmin:async()=>ctx}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{redirected=url;throw Error('NEXT_REDIRECT');}}));
import {publishNoticeAction,archiveNoticeAction,restoreNoticeAction} from '../app/(app)/admin/notice-board/actions';
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);redirected='';});
const form=(id:string)=>{const fd=new FormData();fd.set('id',id);return fd;};
describe('notice lifecycle action confirmations',()=>{
 it('keeps successful publish, archive and restore redirects outside business-error handling',async()=>{
  await hireEmployee(ctx,{person:{fullName:'Fictional notice recipient',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const {id}=await createNotice(ctx,{title:'Fictional action confirmation',body:'Local test notice.',startOn:todayInKualaLumpur(),endOn:todayInKualaLumpur()});
  await expect(publishNoticeAction(form(id))).rejects.toThrow('NEXT_REDIRECT');
  expect(new URL(redirected,'http://localhost').searchParams.get('toast')).toBe('Published to 1 employee(s)');
  expect((await getNotice(ctx,id))!.publishedAt).not.toBeNull();
  await expect(archiveNoticeAction(form(id))).rejects.toThrow('NEXT_REDIRECT');
  expect(new URL(redirected,'http://localhost').searchParams.get('toast')).toBe('Notice archived');
  expect((await getNotice(ctx,id))!.archivedAt).not.toBeNull();
  await expect(restoreNoticeAction(form(id))).rejects.toThrow('NEXT_REDIRECT');
  expect(new URL(redirected,'http://localhost').searchParams.get('toast')).toBe('Notice restored');
  expect((await getNotice(ctx,id))!.archivedAt).toBeNull();
 });
 it('still redirects actual lifecycle refusals through the error path',async()=>{
  const {id}=await createNotice(ctx,{title:'Fictional empty audience',body:'Nobody is employed in this fixture.',startOn:todayInKualaLumpur(),endOn:todayInKualaLumpur()});
  await expect(publishNoticeAction(form(id))).rejects.toThrow('NEXT_REDIRECT');
  expect(new URL(redirected,'http://localhost').searchParams.has('error')).toBe(true);
  expect((await getNotice(ctx,id))!.publishedAt).toBeNull();
 });
});
