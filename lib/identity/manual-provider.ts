import { keycloakConfig } from './config';
import { identityFetch } from './oidc';
import { ManualIdentityError, type ManualIdentityEnrollment } from './manual-model';

export type ManualAccountProvider = {
  create:(enrollment:ManualIdentityEnrollment)=>Promise<string>;
  setPassword:(enrollment:ManualIdentityEnrollment,password:string)=>Promise<void>;
  enable:(enrollment:ManualIdentityEnrollment)=>Promise<void>;
  cancel:(enrollment:ManualIdentityEnrollment)=>Promise<void>;
};
type Account={id:string;username:string;email:string;emailVerified:boolean;enabled:boolean;
  requiredActions?:string[];federationLink?:string;serviceAccountClientId?:string};

/** Reuses the existing realm-scoped user-management client; never accepts an endpoint from a form. */
export function manualAccountProvider():ManualAccountProvider {
  const config=keycloakConfig();
  let token:Promise<string>|undefined;
  const adminBase=config.issuer.replace('/realms/','/admin/realms/');
  async function accessToken() {
    const client=process.env.KEYCLOAK_ADMIN_CLIENT_ID,secret=process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
    if(!client||!secret)throw new ManualIdentityError('unavailable');
    const response=await identityFetch(config)(`${config.issuer}/protocol/openid-connect/token`,{method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'client_credentials',client_id:client,client_secret:secret})});
    if(!response.ok)throw new ManualIdentityError('unavailable');
    const value:unknown=await response.json();
    if(!value||typeof value!=='object'||!('access_token'in value)||typeof value.access_token!=='string')throw new ManualIdentityError('unavailable');
    return value.access_token;
  }
  async function admin(path:string,method='GET',body?:unknown) {
    const url=new URL(adminBase+path);
    const target=config.backchannel?new URL(url.pathname+url.search,config.backchannel):url;
    return fetch(target,{method,redirect:'error',signal:AbortSignal.timeout(10_000),
      headers:{authorization:`Bearer ${await(token??=accessToken())}`,'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
  }
  function scoped(e:ManualIdentityEnrollment) {
    if(e.issuer!==config.issuer)throw new ManualIdentityError('forbidden');
  }
  async function account(e:ManualIdentityEnrollment,allowMissing=false):Promise<Account|null> {
    scoped(e);
    if(!e.subject||!/^[a-zA-Z0-9_-]{1,128}$/.test(e.subject))throw new ManualIdentityError('conflict');
    const r=await admin(`/users/${e.subject}`);
    if(allowMissing&&r.status===404)return null;
    if(!r.ok)throw new ManualIdentityError('unavailable');
    const a=await r.json() as Account;
    if(a.id!==e.subject||a.username!==e.username||a.email?.toLowerCase()!==e.email||a.emailVerified!==true||
      typeof a.enabled!=='boolean'||a.federationLink||a.serviceAccountClientId)throw new ManualIdentityError('conflict');
    return a;
  }
  return {
    async create(e) {
      scoped(e);
      // An existing username/email is never evidence of ownership. Even a disabled account is not
      // adopted. An uncertain POST requires installation-operator inspection, not password replacement.
      for(const [key,value] of [['username',e.username],['email',e.email]]) {
        const r=await admin(`/users?${new URLSearchParams({[key]:value,exact:'true',max:'2'})}`);
        if(!r.ok)throw new ManualIdentityError('unavailable');
        const users:unknown=await r.json();
        if(!Array.isArray(users))throw new ManualIdentityError('unavailable');
        if(users.length)throw new ManualIdentityError('conflict');
      }
      let response:Response;
      try {response=await admin('/users','POST',{username:e.username,email:e.email,emailVerified:true,enabled:false,requiredActions:['UPDATE_PASSWORD']});}
      catch {throw new ManualIdentityError('uncertain');}
      if(response.status===409)throw new ManualIdentityError('conflict');
      if(response.status!==201)throw new ManualIdentityError(response.status>=500?'uncertain':'unavailable');
      const location=response.headers.get('location');
      const subject=location&&new URL(location,adminBase).pathname.match(/\/users\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
      if(!subject)throw new ManualIdentityError('uncertain');
      // Persist this exact response ID before the next read or password mutation.
      return subject;
    },
    async setPassword(e,password) {
      if((await account(e))?.enabled!==false)throw new ManualIdentityError('conflict');
      const r=await admin(`/users/${e.subject}/reset-password`,'PUT',{type:'password',value:password,temporary:true});
      if(r.status===400)throw new ManualIdentityError('invalid');
      if(r.status!==204)throw new ManualIdentityError('unavailable');
      const a=await account(e);
      if(a?.enabled!==false||!a.requiredActions?.includes('UPDATE_PASSWORD'))throw new ManualIdentityError('conflict');
    },
    async enable(e) {
      const a=await account(e);
      if(a?.enabled)return; // Lost response/commit recovery never resets a live password.
      if(!a?.requiredActions?.includes('UPDATE_PASSWORD'))throw new ManualIdentityError('conflict');
      try {await admin(`/users/${e.subject}`,'PUT',{enabled:true});}catch {/* Read back an uncertain write. */}
      if((await account(e))?.enabled!==true)throw new ManualIdentityError('uncertain');
    },
    async cancel(e) {
      scoped(e);
      if(!e.subject)return; // Unknown accounts, including uncertain creations, are never deleted.
      const a=await account(e,true);
      if(!a)return;
      if(a.enabled)throw new ManualIdentityError('conflict');
      try {await admin(`/users/${e.subject}`,'DELETE');}catch {/* Read back before reporting cancellation. */}
      if(await account(e,true))throw new ManualIdentityError('uncertain');
    },
  };
}
