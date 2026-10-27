/** Operator-only staging preparation. No application imports, route activation or secret output. */
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
export const KEY_ID='AI_SPEND_RECEIPT_KEY_ID',KEY_SECRET='AI_SPEND_RECEIPT_SIGNING_KEY';
const digest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const fail:()=>never=()=>{throw Error('Receipt preparation refused; inspect private recovery material with the release operator.');};
export type Pair=Readonly<{id:string;secret:string}>;
export type Verifier=Pair&Readonly<{enabled:boolean;usable:boolean}>;
export type Pending=Readonly<{version:1;environment:'staging';databaseIdentity:string;expectedDatabaseIdentity:string;envPath:string;original:string;originalDigest:string;replacement:string;replacementDigest:string;pair:Pair}>;
export type ReceiptFiles={
 readEnvironment():Promise<string>;
 readPending():Promise<string|null>;
 createPending(value:string):Promise<void>;
 /** Exclusive process lock; must refuse existing locks, including ambiguous abandoned ones. */
 lock():Promise<()=>Promise<void>>;
 /** Recheck exact old contents and replace by fsync + same-directory atomic rename, mode0600. */
 replaceEnvironment(expected:string,replacement:string):Promise<void>;
};
export type ReceiptDatabase={
 /** Must verify actual table owner, schema/column constraints and supported pgcrypto first. */
 inspect():Promise<Readonly<{identity:string;activeKeys:number}>>;
 find(id:string):Promise<Verifier|null>;
 /** Transactional parameterized insert, never UPDATE/retire/delete any existing key. */
 insert(pair:Pair):Promise<void>;
};
export type Preparation={environment:string;apply?:boolean;recover?:boolean;releaseWindowEvidence?:string;expectedDatabaseIdentity?:string;envPath:string};
export type Result=Readonly<{status:'ready'|'needs_provisioning'|'prepared';writes:boolean}>;
export function readReceiptPair(text:string):Pair|null{
 if(Buffer.byteLength(text,'utf8')>262144||text.startsWith('\uFEFF')||text.includes('\0'))fail();
 const values=new Map<string,string>();
 for(const line of text.split(/\r?\n/)){
  const declaration=/^\s*(?:export\s+)?(AI_SPEND_RECEIPT_KEY_ID|AI_SPEND_RECEIPT_SIGNING_KEY)\b(.*)$/.exec(line);if(!declaration)continue;
  if(values.has(declaration[1]))fail();
  const value=/^\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#'"`$\\]+))\s*(?:#.*)?$/.exec(declaration[2]);if(!value)fail();
  values.set(declaration[1],value[1]??value[2]??value[3]);
 }
 if(!values.size)return null;const id=values.get(KEY_ID),secret=values.get(KEY_SECRET);
 if(!id||!/^[A-Za-z0-9_-]{1,64}$/.test(id)||!secret||!/^[a-f0-9]{64}$/i.test(secret))fail();
 return Object.freeze({id,secret:secret.toLowerCase()});
}
function same(left:Pair,right:Pair):boolean{return left.id===right.id&&timingSafeEqual(Buffer.from(left.secret,'hex'),Buffer.from(right.secret,'hex'));}
function pendingValue(text:string,options:Preparation,identity:string):Pending{
 let p:Pending;try{p=JSON.parse(text) as Pending;}catch{return fail();}
 if(!p||Object.keys(p).sort().join(',')!=='databaseIdentity,envPath,environment,expectedDatabaseIdentity,original,originalDigest,pair,replacement,replacementDigest,version'||p.version!==1||p.environment!=='staging'||p.databaseIdentity!==identity||p.expectedDatabaseIdentity!==identity||options.expectedDatabaseIdentity!==undefined&&p.expectedDatabaseIdentity!==options.expectedDatabaseIdentity||p.envPath!==options.envPath||typeof p.original!=='string'||typeof p.replacement!=='string'||digest(p.original)!==p.originalDigest||digest(p.replacement)!==p.replacementDigest||readReceiptPair(p.original)!==null)return fail();
 const actual=readReceiptPair(p.replacement);if(!actual||!p.pair||!same(actual,p.pair))fail();
 const expected=p.original+(p.original.endsWith('\n')?'':'\n')+`${KEY_ID}=${actual.id}\n${KEY_SECRET}=${actual.secret}\n`;
 if(expected!==p.replacement)fail();return p;
}
/** Plan/check is the default. Explicit recovery is required after any pending phase exists.
 * Evidence is an operator's private release-window reference, NOT a substitute for admission. */
export async function prepareReceipt(options:Preparation,files:ReceiptFiles,db:ReceiptDatabase,generate:()=>Buffer=()=>randomBytes(32)):Promise<Result>{
 if(options.environment!=='staging'||!options.envPath.startsWith('/')||options.recover&&!options.apply||options.apply&&(!options.releaseWindowEvidence?.trim()||options.releaseWindowEvidence.length>1024||!options.expectedDatabaseIdentity||!/^[a-f0-9]{64}$/.test(options.expectedDatabaseIdentity))||options.expectedDatabaseIdentity!==undefined&&!/^[a-f0-9]{64}$/.test(options.expectedDatabaseIdentity))fail();
 // Verify independently supplied target identity BEFORE even creating the process lock/recovery files.
 const info=await db.inspect();if(options.expectedDatabaseIdentity!==undefined&&options.expectedDatabaseIdentity!==info.identity)fail();
 const unlock=options.apply?await files.lock():null;
 try{
  const initial=await files.readEnvironment();if(Buffer.byteLength(initial,'utf8')>260000)fail();
  const pair=readReceiptPair(initial),pending=await files.readPending();
  if(pending!==null){
   const saved=pendingValue(pending,options,info.identity);
   if(initial!==saved.original&&initial!==saved.replacement)fail();
   const existing=await db.find(saved.pair.id);
   if(existing&&(!existing.enabled||!existing.usable||!same(existing,saved.pair)))fail();
   if(initial===saved.replacement&&existing)return Object.freeze({status:'ready',writes:false});
   if(!options.recover)fail();
   if(!existing){if(initial!==saved.original||info.activeKeys!==0)fail();await db.insert(saved.pair);}
   if(initial===saved.original)await files.replaceEnvironment(saved.original,saved.replacement);
   return Object.freeze({status:'prepared',writes:initial!==saved.replacement||!existing});
  }
  if(options.recover)fail();
  if(pair){const existing=await db.find(pair.id);if(!existing||!existing.enabled||!existing.usable||!same(existing,pair))fail();return Object.freeze({status:'ready',writes:false});}
  // An env-less deployment with any active verifier is an ambiguous partial/rotation state.
  if(info.activeKeys!==0)fail();
  if(!options.apply)return Object.freeze({status:'needs_provisioning',writes:false});
  const bytes=generate();if(!Buffer.isBuffer(bytes)||bytes.length!==32)fail();
  const next=Object.freeze({id:'receipt-'+randomBytes(12).toString('hex'),secret:bytes.toString('hex')});
  if(await db.find(next.id))fail();
  const replacement=initial+(initial.endsWith('\n')?'':'\n')+`${KEY_ID}=${next.id}\n${KEY_SECRET}=${next.secret}\n`;
  const saved:Pending={version:1,environment:'staging',databaseIdentity:info.identity,expectedDatabaseIdentity:options.expectedDatabaseIdentity!,envPath:options.envPath,original:initial,originalDigest:digest(initial),replacement,replacementDigest:digest(replacement),pair:next};
  // Durable recovery precedes database insertion. Never clear it automatically or rotate keys.
  await files.createPending(JSON.stringify(saved));await db.insert(next);await files.replaceEnvironment(initial,replacement);
  return Object.freeze({status:'prepared',writes:true});
 }finally{await unlock?.();}
}
