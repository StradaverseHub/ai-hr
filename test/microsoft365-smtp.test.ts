/** Real schemas/token parsing; captured HTTP and SMTP boundaries, no tenant credentials. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const smtp=vi.hoisted(()=>({create:vi.fn(),send:vi.fn(),close:vi.fn()}));
vi.mock('nodemailer',()=>({default:{createTransport:smtp.create}}));
import {emailConfigSchema,sameEmailCredential,type EmailConfig} from '../lib/identity/email-model';
import {deliveryEmailRelay} from '../lib/identity/email-relay';
import {prepareSmtpRelay} from '../lib/internal-auth/smtp-credentials';
import {sendSmtp} from '../lib/internal-auth/smtp';
const config:EmailConfig={host:'smtp.office365.com',port:587,security:'starttls',from:'hr@example.test',fromName:'AI HR',replyTo:'',auth:true,user:'hr@example.test',authentication:'microsoft365',oauth2:{tenantId:crypto.randomUUID(),clientId:crypto.randomUUID()}};
const stored={config,password:'fictional-client-secret'},token='fictional-access-token',now=Date.now();
const body={access_token:token,token_type:'Bearer',expires_in:3600};
beforeEach(()=>{vi.resetAllMocks();smtp.create.mockReturnValue({sendMail:smtp.send,close:smtp.close});smtp.send.mockResolvedValue({accepted:['recipient@example.test']});});
afterEach(()=>vi.unstubAllGlobals());
describe('Microsoft 365 application SMTP credentials',()=>{
 it('requests only the fixed tenant endpoint and Exchange client-credentials scope, and returns no reusable secret',async()=>{
  const http=vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
  const result=await prepareSmtpRelay(stored,{fetch:http,now:()=>now});
  expect(http).toHaveBeenCalledOnce();const [url,options]=http.mock.calls[0];
  expect(url).toBe(`https://login.microsoftonline.com/${config.oauth2!.tenantId}/oauth2/v2.0/token`);
  expect(options).toMatchObject({method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'}});
  expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({client_id:config.oauth2!.clientId,client_secret:stored.password,grant_type:'client_credentials',scope:'https://outlook.office365.com/.default'});
  expect(result).toEqual({config,accessToken:token,accessTokenExpiresAt:now+3600000});expect(JSON.stringify(result)).not.toContain(stored.password);
  expect(deliveryEmailRelay.safeParse(stored).success).toBe(false);
  expect(deliveryEmailRelay.safeParse({...result,password:stored.password}).success).toBe(false);
 });
 it.each([{host:'evil.test'},{port:465},{security:'tls'},{auth:false},{user:'not-a-mailbox'},{oauth2:undefined},{oauth2:{...config.oauth2,tenantId:'../common'}},{endpoint:'https://evil.test'}])('rejects malformed or redirected application configuration: %j',patch=>{
  expect(emailConfigSchema.safeParse({...config,...patch}).success).toBe(false);
 });
 it('requires a new secret when switching application, tenant, mailbox or authentication mode',()=>{
  expect(sameEmailCredential(config,{...config})).toBe(true);
  for(const changed of [{...config,user:'other@example.test'},{...config,oauth2:{...config.oauth2!,tenantId:crypto.randomUUID()}},{...config,oauth2:{...config.oauth2!,clientId:crypto.randomUUID()}},{...config,authentication:undefined,oauth2:undefined}])expect(sameEmailCredential(config,changed)).toBe(false);
 });
 it.each([
  ()=>Response.json({error_description:stored.password},{status:401}),()=>new Response('not-json'),
  ()=>Response.json({...body,access_token:'a\r\nb'}),()=>Response.json({...body,token_type:'MAC'}),
  ()=>Response.json({...body,expires_in:30}),()=>Response.json({...body,expires_in:'3600'}),
  ()=>new Response('x'.repeat(32769)),()=>Response.json({...body,access_token:'x'.repeat(16385)}),
 ])('sanitizes provider refusal/malformed/oversized credentials and creates no SMTP transport',async response=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response()));
  await expect(sendSmtp(stored,{to:'recipient@example.test',subject:'Test',text:'Test'})).rejects.toMatchObject({code:'authenticationFailed',message:'Identity email settings: authenticationFailed'});
  expect(smtp.create).not.toHaveBeenCalled();
 });
 it('counts token lifetime from request start and refuses expired prepared tokens without trying the provider',async()=>{
  let clock=now;const http=vi.fn<typeof fetch>().mockImplementation(async()=>{clock=now+61000;return Response.json({...body,expires_in:120});});
  await expect(prepareSmtpRelay(stored,{fetch:http,now:()=>clock})).rejects.toMatchObject({code:'authenticationFailed'});
  http.mockClear();await expect(prepareSmtpRelay({config,accessToken:token,accessTokenExpiresAt:now+60000},{fetch:http,now:()=>now})).rejects.toMatchObject({code:'authenticationFailed'});expect(http).not.toHaveBeenCalled();
 });
 it('uses SASL XOAUTH2 with mandatory STARTTLS, TLS verification and no SMTP password',async()=>{
  const http=vi.fn().mockResolvedValue(Response.json(body));vi.stubGlobal('fetch',http);
  await sendSmtp(stored,{to:'recipient@example.test',subject:'Test',text:'Test'});
  expect(smtp.create).toHaveBeenCalledWith(expect.objectContaining({host:'smtp.office365.com',port:587,secure:false,requireTLS:true,auth:{type:'OAuth2',user:config.user,accessToken:token},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'}}));
  expect(JSON.stringify(smtp.create.mock.calls)).not.toContain(stored.password);expect(smtp.close).toHaveBeenCalledOnce();
  http.mockClear();await sendSmtp({config,accessToken:token,accessTokenExpiresAt:Date.now()+3600000},{to:'recipient@example.test',subject:'Prepared',text:'Test'});expect(http).not.toHaveBeenCalled();
 });
 it('also requires STARTTLS for a password relay when selected',async()=>{
  await sendSmtp({config:{...config,authentication:undefined,oauth2:undefined},password:'fictional-password'},{to:'recipient@example.test',subject:'Test',text:'Test'});
  expect(smtp.create).toHaveBeenCalledWith(expect.objectContaining({secure:false,requireTLS:true,auth:{user:config.user,pass:'fictional-password'}}));
 });
});
