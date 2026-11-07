/** Lossless representation/binding models, not a native inventory or activation. */
import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalizeNotificationCanonicalInventory,nativeInventoryCanonical,nativeInventoryLimits} from './fixtures/notification-worker/canonical-inventory';
import {assertInventoryLedger,inventoryRegularBytes,writeInventoryEvidence} from './fixtures/notification-worker/canonical-inventory-evidence';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function sample(offset=0){
 const type={oid:16+offset,schema:'pg_catalog',namespaceOid:11+offset,name:'bool',identity:'pg_catalog.bool',formatted:'boolean',raw:{oid:String(16+offset),typnamespace:String(11+offset),typname:'bool'}};
 const raw={oid:String(101+offset),proname:'example',pronamespace:String(201+offset),proowner:String(301+offset),prolang:String(401+offset),prorettype:String(16+offset),proargtypes:[String(16+offset)],proallargtypes:null,protrftypes:null,provariadic:'0',prosupport:'-',proacl:null,
  procost:100,prorows:0,prokind:'f',prosecdef:true,proleakproof:false,proisstrict:false,proretset:false,provolatile:'v',proparallel:'u',pronargs:1,pronargdefaults:0,proargmodes:null,proargnames:['input'],prosrc:'BEGIN -- 9001 is source, not an OID replacement\n RETURN TRUE; END',probin:null,prosqlbody:null,proconfig:['search_path=pg_catalog'],proargdefaults:null};
 const row={raw,signature:'app.example(boolean)',namespace:{oid:201+offset,name:'app',raw:{oid:String(201+offset),nspname:'app'}},owner:{oid:301+offset,name:'app_owner'},language:{oid:401+offset,name:'plpgsql',raw:{oid:String(401+offset),lanname:'plpgsql'}},returnType:type,inputTypes:[type],allTypes:null,transformTypes:null,variadicType:null,support:null,supportOid:0,supportText:'-',acl:[{grantorOid:301+offset,grantor:'app_owner',granteeOid:0,grantee:'PUBLIC',privilege:'EXECUTE',grantable:false}],nativeArguments:'input boolean',nativeIdentityArguments:'input boolean',nativeResult:'boolean',nativeDefaults:null,nativeDefinition:'CREATE FUNCTION app.example(input boolean) RETURNS boolean ...',sourceBytes:Buffer.byteLength(raw.prosrc),sourceSha256:hash(raw.prosrc)};
 return{columns:Object.keys(raw),functionCount:1,functions:[row],dependencies:[{raw:{classid:'1255',objid:String(101+offset),refclassid:'2615',refobjid:String(201+offset)},object:{identity:'app.example(boolean)'},reference:{identity:'app'}}],sharedDependencies:[{raw:{classid:'1255',objid:String(101+offset),refclassid:'1260',refobjid:String(301+offset)},referenceRole:{oid:301+offset,name:'app_owner'}}]};
}
const directories:string[]=[];const directory=()=>{const value=mkdtempSync(join(tmpdir(),'aihr-canonical-inventory-model-'));directories.push(value);return value;};
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
it('normalizes only typed references and preserves complete bodies, ACL representation and bidirectional membership',()=>{
 const before=sample(),after=sample(1000),a=normalizeNotificationCanonicalInventory(before),b=normalizeNotificationCanonicalInventory(after);
 expect(a.normalizedSha256).toBe(b.normalizedSha256);expect(a.rawSha256).not.toBe(b.rawSha256);expect(a.normalized[0].prosrc).toBe(before.functions[0].raw.prosrc);
 expect(a).toMatchObject({functionCount:1,expectedProfileAuthorized:false,releaseAuthorized:false,portableExpectedProfileApproved:false});
 expect(a.dependencies).toMatchObject({rawRows:1,sharedRows:1});expect(a.dependencies.rawSha256).not.toBe(b.dependencies.rawSha256);
 expect(normalizeNotificationCanonicalInventory({...before,functions:[{...before.functions[0],raw:{...before.functions[0].raw,proacl:[]},acl:[]}]}).normalizedSha256).not.toBe(a.normalizedSha256);
 expect(()=>normalizeNotificationCanonicalInventory({...before,functions:[]})).toThrow(/inventory/);
 expect(()=>normalizeNotificationCanonicalInventory({...before,functionCount:2,functions:[before.functions[0],before.functions[0]]})).toThrow(/Duplicate/);
});
it('retains opaque native node/default/external/unknown metadata without OID text rewriting or silent omission',()=>{
 const original=sample(),base=original.functions[0],opaque='{CONST :consttype 2950 :location 17 :constvalue 16 [ 1 2 3 ]}';
 const capture={...original,columns:[...original.columns,'future_native_oid_node'],functions:[{...base,raw:{...base.raw,proargdefaults:opaque,prosqlbody:opaque,probin:'$libdir/example',future_native_oid_node:'native 9001 opaque'},nativeDefaults:"'00000000-0000-0000-0000-000000000000'::uuid"}]};
 const result=normalizeNotificationCanonicalInventory(capture);expect(result.normalized[0]).toMatchObject({proargdefaults:opaque,prosqlbody:opaque,probin:'$libdir/example',future_native_oid_node:'native 9001 opaque'});
 expect(result.unresolvedPortability.map(row=>row.field)).toEqual(['prosrc','proargdefaults','prosqlbody','probin','future_native_oid_node']);expect(result.unknownColumns).toEqual(['future_native_oid_node']);
 expect(()=>normalizeNotificationCanonicalInventory({...capture,columns:original.columns})).toThrow(/column membership/);
});
it('refuses source-byte damage, wrong native reference maps and native JSON values which serialization would erase',()=>{
 const value=sample(),row=value.functions[0];
 expect(()=>normalizeNotificationCanonicalInventory({...value,functions:[{...row,raw:{...row.raw,prosrc:row.raw.prosrc+' '}}]})).toThrow(/source bytes/);
 expect(()=>normalizeNotificationCanonicalInventory({...value,functions:[{...row,returnType:{...row.returnType,oid:99}}]})).toThrow(/return type/);
 expect(()=>normalizeNotificationCanonicalInventory({...value,functions:[{...row,raw:{...row.raw,proargtypes:['999']}}]})).toThrow(/input OID/);
 expect(()=>normalizeNotificationCanonicalInventory({...value,functions:[{...row,supportText:'other'}]})).toThrow(/regproc/);
 for(const invalid of [undefined,new Date(),BigInt(1),NaN,Infinity,{lost:undefined},Array(2)])expect(()=>nativeInventoryCanonical(invalid)).toThrow();
 const unicode='補助😀\u0301';expect(JSON.parse(nativeInventoryCanonical({z:unicode,a:[null,true]}))).toEqual({a:[null,true],z:unicode});
});
it('requires the complete true ordered fresh-CI ledger without historical normalization, sorting or fake records',()=>{
 const a='a'.repeat(64),b='b'.repeat(64),source={migrations:[{sha256:a,when:200},{sha256:b,when:100}]},ledger=[{id:2,hash:a,created_at:'200'},{id:5,hash:b,created_at:'100'}];
 expect(assertInventoryLedger(source,ledger)).toEqual(ledger);
 for(const invalid of [ledger.slice(0,1),[...ledger].reverse(),[ledger[0],{...ledger[1],hash:a}],[ledger[0],{...ledger[1],created_at:'200'}],[...ledger,{id:9,hash:a,created_at:'300'}]])expect(()=>assertInventoryLedger(source,invalid)).toThrow();
});
it('owns complete private evidence bytes and refuses symlinks, duplicate publication and oversized incomplete membership',()=>{
 const dir=directory(),value={full:'every raw source byte 😀',complete:true},saved=writeInventoryEvidence(dir,'notification-canonical-raw.json',value),bytes=readFileSync(join(dir,saved.file));
 expect(saved).toMatchObject({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});expect(inventoryRegularBytes(join(dir,saved.file),nativeInventoryLimits.fileBytes,true).equals(bytes)).toBe(true);
 expect(()=>writeInventoryEvidence(dir,'notification-canonical-raw.json',{replaced:true})).toThrow();
 symlinkSync(join(dir,saved.file),join(dir,'link.json'));expect(()=>inventoryRegularBytes(join(dir,'link.json'),nativeInventoryLimits.fileBytes)).toThrow();
 expect(()=>writeInventoryEvidence(dir,'../escape.json',value)).toThrow();
 expect(()=>writeInventoryEvidence(dir,'notification-canonical-source.json',{full:'x'.repeat(nativeInventoryLimits.fileBytes)})).toThrow(/16MiB/);
 const incomplete={complete:false,expectedProfileAuthorized:false,reason:'full byte bound refused'};writeInventoryEvidence(dir,'notification-canonical-incomplete.json',incomplete);expect(JSON.parse(readFileSync(join(dir,'notification-canonical-incomplete.json'),'utf8'))).toEqual(incomplete);
 writeFileSync(join(dir,'foreign.json'),'{}',{mode:0o644});expect(()=>inventoryRegularBytes(join(dir,'foreign.json'),1024,true)).toThrow();
});
