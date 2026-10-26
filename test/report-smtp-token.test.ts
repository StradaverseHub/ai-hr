/** Fixed Unix capability contract; no installed socket, network or database is used. */
import {EventEmitter} from 'node:events';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const wire=vi.hoisted(()=>({connect:vi.fn()}));
vi.mock('node:net',async original=>({...await original<typeof import('node:net')>(),connect:wire.connect}));
import {prepareReportSmtpRelay} from '../lib/internal-auth/report-smtp-token';
import type {StoredEmailRelay} from '../lib/identity/email-relay';
const config:StoredEmailRelay['config']={host:'smtp.office365.com',port:587,security:'starttls',user:'hr@example.test',from:'hr@example.test',fromName:'HR',replyTo:'',auth:true,authentication:'microsoft365',oauth2:{tenantId:crypto.randomUUID(),clientId:crypto.randomUUID()}};
const input={config,password:'fictional-client-secret'};
beforeEach(()=>vi.clearAllMocks());
function fixture(body:unknown){
 const socket=Object.assign(new EventEmitter(),{end:vi.fn(),destroy:vi.fn()});
 socket.destroy.mockImplementation((error:Error)=>{socket.emit('error',error);socket.emit('close');return socket;});
 socket.end.mockImplementation(()=>{queueMicrotask(()=>{socket.emit('data',Buffer.from(typeof body==='string'?body:JSON.stringify(body)));socket.emit('end');socket.emit('close');});return socket;});
 wire.connect.mockImplementation(()=>{queueMicrotask(()=>socket.emit('connect'));return socket;});return socket;
}
describe('Reports token capability client',()=>{
 it('uses only the fixed private socket and sends no Auth key, database, target, config or caller URL',async()=>{
  const token={accessToken:'fictional-token',accessTokenExpiresAt:Date.now()+3600000},socket=fixture(token);
  expect(await prepareReportSmtpRelay(input)).toEqual({config,...token});expect(wire.connect).toHaveBeenCalledWith({path:'/run/aihr-smtp-token.sock'});
  expect(JSON.parse(socket.end.mock.calls[0][0])).toEqual({...config.oauth2,clientSecret:input.password});
 });
 it.each([{},'not-json','x'.repeat(49153),{accessToken:'fictional-token',accessTokenExpiresAt:1},{accessToken:'fictional-token',accessTokenExpiresAt:Date.now()+3600000,password:'leaked-secret'}])('rejects an unavailable, malformed, oversized, expired or credential-bearing reply',async body=>{
  fixture(body);await expect(prepareReportSmtpRelay(input)).rejects.toMatchObject({code:'authenticationFailed',message:'Identity email settings: authenticationFailed'});
 });
 it('preserves a password relay without requesting the token helper',async()=>{
  const relay={config:{...config,authentication:undefined,oauth2:undefined},password:input.password};expect(await prepareReportSmtpRelay(relay)).toEqual(relay);expect(wire.connect).not.toHaveBeenCalled();
 });
});
