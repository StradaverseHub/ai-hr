import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),admit:vi.fn(),add:vi.fn(),read:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/notice',()=>({noticeAttachmentUploadState:mocks.admit,addNoticeAttachment:mocks.add,getNoticeAttachment:mocks.read,NOTICE_ATTACHMENT_MAX_BYTES:10485760,NoticeAttachmentError:class extends Error{}}));
import {POST} from '../app/(app)/admin/notice-board/[id]/attachments/route';
import {GET} from '../app/(app)/notices/[id]/attachment/[attachmentId]/route';
const url='http://localhost:3197/admin/notice-board/notice/attachments',params=Promise.resolve({id:'notice'});
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({tenantId:'tenant',userId:'actual'});mocks.admit.mockResolvedValue({id:'notice',contentVersion:1});mocks.add.mockResolvedValue({id:'asset',contentVersion:1,attachment:{id:'asset',fileName:'fictional.txt',mimeType:'text/plain',byteLength:7}});});
describe('Notice attachment HTTP boundaries',()=>{
 it('refuses foreign origin or missing actual authority before reading a file',async()=>{
  expect((await POST(new Request(url,{method:'POST',headers:{origin:'https://foreign.invalid'}}),{params})).status).toBe(403);expect(mocks.session).not.toHaveBeenCalled();
  mocks.admit.mockResolvedValue(null);expect((await POST(new Request(url,{method:'POST',headers:{origin:'http://localhost:3197'}}),{params})).status).toBe(404);expect(mocks.add).not.toHaveBeenCalled();
 });
 it('passes only actual session, displayed version and bytes to the staged writer',async()=>{
  const data=new FormData();data.set('file',new File(['Content'],'fictional.txt',{type:'text/html'}));data.set('uploadKey','intent');data.set('contentVersion','1');
  const result=await POST(new Request(url,{method:'POST',body:data,headers:{origin:'http://localhost:3197'}}),{params});
  expect(result.status).toBe(201);expect(mocks.add).toHaveBeenCalledWith({tenantId:'tenant',userId:'actual'},'notice',1,{uploadKey:'intent',fileName:'fictional.txt',content:Buffer.from('Content')},{attach:false});
  expect(result.headers.get('cache-control')).toBe('private, no-store');
 });
 it('reauthorizes downloads and sends private attachment-only nosniff bytes with a safe filename',async()=>{
  const input={params:Promise.resolve({id:'notice',attachmentId:'asset'})};mocks.read.mockResolvedValue(null);
  expect((await GET(new Request(url),input)).status).toBe(404);
  mocks.read.mockResolvedValue({fileName:'fictional"\r\n文件.txt',mimeType:'text/plain',content:Buffer.from('Fictional bytes')});
  const result=await GET(new Request(url+'?inline=1'),input);expect(await result.text()).toBe('Fictional bytes');
  expect(mocks.read).toHaveBeenLastCalledWith({tenantId:'tenant',userId:'actual'},'notice','asset');
  expect(result.headers.get('content-disposition')).toMatch(/^attachment;/);expect(result.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
  expect(result.headers.get('x-content-type-options')).toBe('nosniff');expect(result.headers.get('cache-control')).toBe('private, no-store');
 });
});
