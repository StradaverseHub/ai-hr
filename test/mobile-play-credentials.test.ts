/** Actual Google SDK signs synthetic RSA credentials. All HTTP is synthetic; no Google account is used. */
import {generateKeyPairSync,verify} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createPlayServiceAccountProvider,readDeployedPlayCredentials,PlayCredentialsUnavailableError} from '../lib/mobile-api/play-credentials';
const scope='https://www.googleapis.com/auth/playintegrity';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const credential={type:'service_account',client_email:'clock@synthetic-project.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const response=()=>Response.json({access_token:'synthetic-oauth-access',token_type:'Bearer',expires_in:3600,privateExtra:'never retained'});
const signal=()=>new AbortController().signal;
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('bounded Play service-account assembly with the actual Google JWT client',()=>{
 it('signs a verifiable fixed-scope assertion and exchanges it only at the fixed OAuth endpoint',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>response()),provider=createPlayServiceAccountProvider({...credential,token_uri:'https://evil.example/token',subject:'another-user',universe_domain:'evil.example',private_key_file:'/never-read'},{transport});
  expect(provider).not.toBeNull();expect(await provider!(scope,signal())).toBe('synthetic-oauth-access');expect(transport).toHaveBeenCalledOnce();
  const [url,init]=transport.mock.calls[0];expect(url).toBe('https://oauth2.googleapis.com/token');expect(init).toMatchObject({method:'POST',redirect:'error',cache:'no-store'});
  const form=new URLSearchParams(String(init!.body));expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  const parts=form.get('assertion')!.split('.'),head=JSON.parse(Buffer.from(parts[0],'base64url').toString()),claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
  expect(head.alg).toBe('RS256');expect(claims).toMatchObject({iss:credential.client_email,scope,aud:'https://oauth2.googleapis.com/token'});expect(claims).not.toHaveProperty('sub');
  expect(verify('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),publicKey,Buffer.from(parts[2],'base64url'))).toBe(true);
  expect(claims.exp-claims.iat).toBe(3600);expect(init!.signal!.aborted).toBe(true);
 });
 it('rejects missing/unsupported credentials, malformed keys and invalid deadlines without HTTP',()=>{
  const transport=vi.fn<typeof fetch>(),weak=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey,ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey;
  for(const value of [null,{}, {...credential,type:'authorized_user'},{...credential,client_email:'person@example.com'},{...credential,private_key:'not a key'},{...credential,private_key:weak.export({type:'pkcs8',format:'pem'}).toString()},{...credential,private_key:ec.export({type:'pkcs8',format:'pem'}).toString()}])expect(createPlayServiceAccountProvider(value,{transport})).toBeNull();
  for(const timeoutMs of [0,-1,10001,NaN])expect(createPlayServiceAccountProvider(credential,{transport,timeoutMs})).toBeNull();expect(transport).not.toHaveBeenCalled();
 });
 it('refuses alternate scopes and already aborted calls before spending an exchange',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>response()),provider=createPlayServiceAccountProvider(credential,{transport})!,abort=new AbortController();abort.abort();
  await expect(provider('other-scope',signal())).rejects.toBeInstanceOf(PlayCredentialsUnavailableError);await expect(provider(scope,abort.signal)).rejects.toBeInstanceOf(PlayCredentialsUnavailableError);expect(transport).not.toHaveBeenCalled();
 });
 it('does not retry failed exchanges or leak credential/body diagnostics through its error',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>new Response('PRIVATE_OAUTH_DIAGNOSTIC',{status:503})),provider=createPlayServiceAccountProvider(credential,{transport})!;
  await expect(provider(scope,signal())).rejects.toMatchObject({name:'PlayCredentialsUnavailableError',message:'Google authorization unavailable'});expect(transport).toHaveBeenCalledOnce();
 });
 it.each(['bad-token','bad-type','bad-expiry','invalid-json','oversized'] as const)('refuses %s OAuth response with no usable access token',async kind=>{
  const transport=vi.fn<typeof fetch>(async()=>kind==='invalid-json'?new Response('{'):kind==='oversized'?Response.json({access_token:'synthetic-oauth-access',token_type:'Bearer',expires_in:3600,padding:'x'.repeat(32769)}):Response.json({access_token:kind==='bad-token'?'with space':'synthetic-oauth-access',token_type:kind==='bad-type'?'Other':'Bearer',expires_in:kind==='bad-expiry'?0:3600}));
  await expect(createPlayServiceAccountProvider(credential,{transport})!(scope,signal())).rejects.toBeInstanceOf(PlayCredentialsUnavailableError);expect(transport).toHaveBeenCalledOnce();
 });
 it('bounds a stalled OAuth body, cancels its owned reader and never retries',async()=>{
  let cancelled=false;const transport=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}})));
  await expect(createPlayServiceAccountProvider(credential,{transport,timeoutMs:200})!(scope,signal())).rejects.toBeInstanceOf(PlayCredentialsUnavailableError);
  expect(transport).toHaveBeenCalledOnce();expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true);await vi.waitFor(()=>expect(cancelled).toBe(true));
 });
 it('bounds a fetch that ignores cancellation before any OAuth headers arrive',async()=>{
  let release!:(value:Response)=>void,lateReturned=false;const pending=new Promise<Response>(r=>{release=r;});
  const late=setTimeout(()=>{lateReturned=true;release(response());},1200),transport=vi.fn<typeof fetch>(async()=>pending);
  try{await expect(createPlayServiceAccountProvider(credential,{transport,timeoutMs:200})!(scope,signal())).rejects.toBeInstanceOf(PlayCredentialsUnavailableError);
   expect(lateReturned).toBe(false);expect(transport).toHaveBeenCalledOnce();expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true);
  }finally{clearTimeout(late);release(response());}
 });
 it('cancels a pending exchange, ignores its late result and leaves the next call independent',async()=>{
  let release!:(value:Response)=>void;const pending=new Promise<Response>(r=>{release=r;}),transport=vi.fn<typeof fetch>().mockImplementationOnce(()=>pending).mockImplementation(async()=>response());
  const provider=createPlayServiceAccountProvider(credential,{transport})!,abort=new AbortController(),result=Promise.allSettled([provider(scope,abort.signal)]);
  try{await vi.waitFor(()=>expect(transport).toHaveBeenCalledOnce());abort.abort();expect((await result)[0]).toMatchObject({status:'rejected',reason:{name:'PlayCredentialsUnavailableError'}});expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true);}
  finally{release(response());}
  expect(await provider(scope,signal())).toBe('synthetic-oauth-access');expect(transport).toHaveBeenCalledTimes(2);
 });
 it('does not cache a last-good deployment credential and vetoes a changed in-flight snapshot',async()=>{
  vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',JSON.stringify(credential));const original=readDeployedPlayCredentials();expect(original.accessToken).not.toBeNull();
  vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT','');expect(readDeployedPlayCredentials().accessToken).toBeNull();expect(()=>original.assertCurrent()).toThrow();
  for(const value of ['{','x'.repeat(32769)]){vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',value);expect(readDeployedPlayCredentials().accessToken).toBeNull();}
  vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT',JSON.stringify(credential));const transport=vi.fn<typeof fetch>(async()=>{vi.stubEnv('AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT','');return response();});vi.stubGlobal('fetch',transport);
  await expect(readDeployedPlayCredentials().accessToken!(scope,signal())).rejects.toBeInstanceOf(PlayCredentialsUnavailableError);expect(transport).toHaveBeenCalledOnce();
 });
});
