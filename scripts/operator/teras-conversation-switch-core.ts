/** Staging operator path for the Noveri conversation switch (ADR-0169 §5.1 staging exception, 2 November 2026:
 * "Can switch on for every company in staging"; staging holds fictional data only).
 *
 * Pure planning and apply logic over an injected database, so tests exercise it without a server. It never runs
 * against anything but an environment named `staging`, refuses unless the operator confirms the data is fictional,
 * and applies only to the database whose identity the dry run printed. It never touches production: there is no
 * production mode, and switching on stays a separate, per-tenant administrator decision everywhere else.
 * Each tenant's change is one transaction: the switch row with the operator attribution (migration 0901), and an
 * audit event carrying the state before and after. Switching off (`--off`) is allowed in staging too, so the
 * operator can withdraw it if real personal data ever reaches staging. */
export type SwitchRow=Readonly<{tenantId:string;tenantName:string;enabled:boolean}>;
export interface SwitchDatabase{
 /** sha256 hex of the database's oid, server address, port and name. */
 identity():Promise<string>;
 tenants():Promise<readonly SwitchRow[]>;
 /** One transaction per tenant: upsert the conversation row and append the audit event. Returns the new version. */
 apply(tenantId:string,enabled:boolean,operator:string,from:boolean):Promise<number>;
}
export type SwitchArguments=Readonly<{environment:'staging';enabled:boolean;apply:boolean;operator:string;confirmFictional:boolean;expectedIdentity:string|null}>;
export class SwitchRefused extends Error{constructor(reason:string){super('Conversation switch refused: '+reason+'. Nothing was changed.');this.name='SwitchRefused';}}

export function parseSwitchArguments(args:readonly string[]):SwitchArguments{
 const value=new Map<string,string>(),flags=new Set<string>();
 for(let i=0;i<args.length;i++){
  const key=args[i];
  if(['--apply','--off','--confirm-fictional-data'].includes(key)){if(flags.has(key))throw new SwitchRefused('repeated '+key);flags.add(key);continue;}
  if(!['--environment','--operator','--expected-database-identity'].includes(key)||value.has(key)||!args[i+1]||args[i+1].startsWith('--'))throw new SwitchRefused('unexpected argument '+key);
  value.set(key,args[++i]);
 }
 if(value.get('--environment')!=='staging')throw new SwitchRefused('only --environment staging is supported');
 const operator=value.get('--operator')??'';
 if(!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(operator))throw new SwitchRefused('--operator must be a short lowercase label');
 const expected=value.get('--expected-database-identity')??null;
 if(flags.has('--apply')&&(!expected||!/^[a-f0-9]{64}$/.test(expected)))throw new SwitchRefused('--apply needs the --expected-database-identity the dry run printed');
 if(flags.has('--apply')&&!flags.has('--off')&&!flags.has('--confirm-fictional-data'))throw new SwitchRefused('switching on needs --confirm-fictional-data');
 return Object.freeze({environment:'staging',enabled:!flags.has('--off'),apply:flags.has('--apply'),operator:'operator:'+operator,confirmFictional:flags.has('--confirm-fictional-data'),expectedIdentity:expected});
}

export type SwitchPlan=Readonly<{identity:string;enabled:boolean;applied:boolean;tenants:readonly Readonly<{tenantId:string;tenantName:string;from:boolean;to:boolean;version:number|null}>[]}>;
export async function runSwitch(db:SwitchDatabase,args:SwitchArguments):Promise<SwitchPlan>{
 const identity=await db.identity();
 if(args.apply&&identity!==args.expectedIdentity)throw new SwitchRefused('the database identity does not match the dry run');
 const tenants=await db.tenants(),out:{tenantId:string;tenantName:string;from:boolean;to:boolean;version:number|null}[]=[];
 for(const row of tenants){
  const version=args.apply&&row.enabled!==args.enabled?await db.apply(row.tenantId,args.enabled,args.operator,row.enabled):null;
  out.push({tenantId:row.tenantId,tenantName:row.tenantName,from:row.enabled,to:args.enabled,version});
 }
 return Object.freeze({identity,enabled:args.enabled,applied:args.apply,tenants:Object.freeze(out)});
}
