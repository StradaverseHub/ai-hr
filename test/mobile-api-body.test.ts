import {expect,it} from 'vitest';
import {mobileInput,mobileForm} from '../lib/mobile-api/body';
it('bounds actual streamed bytes even when Content-Length lies',async()=>{const req=new Request('https://hr.example.com/api/mobile/v1/clock',{method:'POST',headers:{'content-type':'application/json','content-length':'1'},body:JSON.stringify({value:'x'.repeat(100)})});await expect(mobileInput(req,32)).rejects.toThrow('Invalid JSON');});
it('rejects duplicate and unrecognized multipart fields',async()=>{for(const extra of ['command','tenantId']){const form=new FormData();form.append('command','{}');form.append(extra,'{}');await expect(mobileForm(new Request('https://hr.example.com',{method:'POST',body:form}),['command'],1024)).rejects.toThrow('Invalid fields');}});
