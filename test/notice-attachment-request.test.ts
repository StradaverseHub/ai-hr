import {describe,expect,it} from 'vitest';
import {noticeUploadSameOrigin,readNoticeUploadRequest} from '../lib/notice-upload-request';
const url='http://localhost:3197/admin/notice-board/notice/attachments';
describe('Bounded Notice upload request',()=>{
 it('requires a browser origin matching the actual host or trusted proxy host',()=>{
  expect(noticeUploadSameOrigin(new Request(url,{headers:{origin:'http://localhost:3197'}}))).toBe(true);
  for(const origin of ['https://foreign.invalid','null','http://localhost:3197/','http://user@localhost:3197'])expect(noticeUploadSameOrigin(new Request(url,{headers:{origin}}))).toBe(false);
  expect(noticeUploadSameOrigin(new Request(url))).toBe(false);
  expect(noticeUploadSameOrigin(new Request(url,{headers:{origin:'https://fictional.example.invalid','x-forwarded-host':'fictional.example.invalid'}}))).toBe(true);
 });
 it('parses one bounded multipart file and rejects malformed bodies',async()=>{
  const data=new FormData();data.set('file',new File(['Fictional content'],'fictional.txt'));data.set('contentVersion','1');
  const parsed=await readNoticeUploadRequest(new Request(url,{method:'POST',body:data}),1024);
  expect(await (parsed.get('file') as File).text()).toBe('Fictional content');
  await expect(readNoticeUploadRequest(new Request(url,{method:'POST',body:'bad',headers:{'content-type':'text/plain'}}),1024)).rejects.toMatchObject({reason:'file'});
 });
 it('bounds streamed bytes even when content-length lies, and cancels before reading the whole stream',async()=>{
  let pulled=0,cancelled=false;
  const body=new ReadableStream<Uint8Array>({pull(controller){pulled++;controller.enqueue(new Uint8Array(32768));},cancel(){cancelled=true;}});
  const request=new Request(url,{method:'POST',body,headers:{'content-type':'multipart/form-data; boundary=x','content-length':'1'},duplex:'half'} as RequestInit);
  await expect(readNoticeUploadRequest(request,1024)).rejects.toMatchObject({reason:'tooLarge',status:413});
  expect(cancelled).toBe(true);expect(pulled).toBeLessThan(8);
 });
});
