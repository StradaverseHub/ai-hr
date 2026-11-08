/** PostgreSQL bootstrap-owner portability oracle, not a permission or owner waiver.
 * Preserve all raw baseline dependency rows/multiplicity. Add only independently
 * BEFORE-derived ownership edges proven by the actual rollback-only pin control. */
import assert from 'node:assert/strict';
import {z} from 'zod';
const oid=z.number().int().safe().positive().max(4294967295);
// pg_proc/pg_type to_jsonb preserves oid's native numeric-string encoding on
// PostgreSQL; resolve ONLY these typed namespace references for set derivation.
const metadataOid=z.union([oid,z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(oid)]);
const nativeKind=z.string().length(1);
export const accessSharedDependency=z.object({dbid:oid,classid:oid,objid:oid,objsubid:z.number().int().safe().nonnegative(),refclassid:oid,refobjid:oid,deptype:z.string().length(1)}).strict();
export type AccessSharedDependency=z.infer<typeof accessSharedDependency>;
const bindingSchema=z.object({database:oid,roleCatalog:oid,namespaceCatalog:oid,functionCatalog:oid,relationCatalog:oid,typeCatalog:oid,oldOwner:oid,newOwner:oid}).strict();
const owned=z.object({oid,owner:oid,details:z.record(z.string(),z.unknown())}).passthrough();
const snapshotSchema=z.object({namespaces:z.array(owned.extend({nspname:z.string()})),functions:z.array(owned),relations:z.array(owned.extend({relnamespace:oid,relname:z.string()})),types:z.array(owned),extensionOwners:z.array(z.object({classid:oid,objid:oid}).passthrough()),sharedDependencies:z.array(accessSharedDependency)}).passthrough();
const transferSchema=z.object({relations:z.array(z.object({oid}).passthrough()),functions:z.array(z.object({oid}).passthrough()),types:z.array(z.object({oid}).passthrough())}).strict();
const pinSchema=z.object({tableOid:oid,typeOid:oid,arrayTypeOid:oid,ownerBefore:oid,ownerAfter:oid,database:oid,relationCatalog:oid,typeCatalog:oid,roleCatalog:oid,before:z.array(accessSharedDependency),after:z.array(accessSharedDependency),rollbackComplete:z.literal(true),objectAbsent:z.literal(true),typesAbsent:z.literal(true),localDependenciesAbsent:z.literal(true),dependenciesAbsent:z.literal(true)}).strict();
const dependencyKey=(row:AccessSharedDependency)=>JSON.stringify([row.dbid,row.classid,row.objid,row.objsubid,row.refclassid,row.refobjid,row.deptype]);
export function accessDependencyCounter(input:unknown){const result=new Map<string,number>();for(const row of z.array(accessSharedDependency).parse(input)){const key=dependencyKey(row);result.set(key,(result.get(key)??0)+1);}return [...result].sort(([a],[b])=>a<b?-1:a>b?1:0);}
export function accessOwnerDependencyExpectation(beforeInput:unknown,transferInput:unknown,bindingInput:unknown,pinInput:unknown){
 const before=snapshotSchema.parse(beforeInput),transfer=transferSchema.parse(transferInput),binding=bindingSchema.parse(bindingInput),pin=pinSchema.parse(pinInput);
 assert.notEqual(binding.oldOwner,binding.newOwner,'Native ownership must actually change');
 assert.notEqual(pin.typeOid,pin.arrayTypeOid,'Native row/array type identities must differ');
 const edge=(classid:number,objid:number,refobjid=binding.oldOwner):AccessSharedDependency=>({dbid:binding.database,classid,objid,objsubid:0,refclassid:binding.roleCatalog,refobjid,deptype:'o'});
 assert.deepEqual({database:pin.database,relationCatalog:pin.relationCatalog,typeCatalog:pin.typeCatalog,roleCatalog:pin.roleCatalog,ownerBefore:pin.ownerBefore,ownerAfter:pin.ownerAfter},
  {database:binding.database,relationCatalog:binding.relationCatalog,typeCatalog:binding.typeCatalog,roleCatalog:binding.roleCatalog,ownerBefore:binding.oldOwner,ownerAfter:binding.newOwner},'Pin control belongs to another native source/owner');
 assert.deepEqual(pin.before,[],'Native bootstrap owner unexpectedly has a dependency');
 assert.deepEqual(pin.after,[edge(binding.relationCatalog,pin.tableOid,binding.newOwner)],'Exact real restricted-owner dependency required');
 const unique=(rows:readonly{oid:number}[],label:string)=>{assert.equal(new Set(rows.map(row=>row.oid)).size,rows.length,'Duplicate native '+label+' objects');};
 for(const [label,rows]of Object.entries({namespaces:before.namespaces,functions:before.functions,relations:before.relations,types:before.types}))unique(rows,label);
 const namespaces=new Map(before.namespaces.map(row=>[row.oid,row]));assert.equal(before.namespaces.filter(row=>row.nspname==='public').length,1);const apps=before.namespaces.filter(row=>row.nspname==='app');assert.equal(apps.length,1);const app=apps[0];assert.equal(app.owner,binding.oldOwner,'Actual old app-schema owner differs');
 const extension=new Set(before.extensionOwners.map(row=>row.classid+':'+row.objid));
 const inScope=(namespace:unknown)=>['public','app'].includes(namespaces.get(metadataOid.parse(namespace))?.nspname??'');
 const targets={
  relations:before.relations.filter(row=>inScope(row.relnamespace)&&row.owner===binding.oldOwner&&['r','p','S','v','m','f'].includes(nativeKind.parse(row.details.relkind))&&!extension.has(binding.relationCatalog+':'+row.oid)),
  functions:before.functions.filter(row=>inScope(row.details.pronamespace)&&row.owner===binding.oldOwner&&['f','p'].includes(nativeKind.parse(row.details.prokind))&&!extension.has(binding.functionCatalog+':'+row.oid)),
  types:before.types.filter(row=>inScope(row.details.typnamespace)&&row.owner===binding.oldOwner&&['e','d'].includes(nativeKind.parse(row.details.typtype))&&!extension.has(binding.typeCatalog+':'+row.oid)),
 };
 for(const label of ['relations','functions','types']as const){unique(transfer[label],label+' transfer');assert.deepEqual(transfer[label].map(row=>row.oid).sort((a,b)=>a-b),targets[label].map(row=>row.oid).sort((a,b)=>a-b),'Executed '+label+' transfer differs from independent BEFORE owners/kinds/extensions');}
 // The probe is rolled back before BEFORE capture and cannot enter either set.
 assert(!before.relations.some(row=>row.oid===pin.tableOid),'Pin-control object leaked into actual inventory');
 assert(!before.types.some(row=>row.oid===pin.typeOid||row.oid===pin.arrayTypeOid),'Pin-control type leaked into actual inventory');
 assert(!before.sharedDependencies.some(row=>row.classid===binding.relationCatalog&&row.objid===pin.tableOid||row.classid===binding.typeCatalog&&(row.objid===pin.typeOid||row.objid===pin.arrayTypeOid)),'Pin-control dependency leaked into actual inventory');
 assert(!before.sharedDependencies.some(row=>row.refclassid===binding.roleCatalog&&row.refobjid===binding.oldOwner),'Pinned bootstrap role unexpectedly referenced before transfer');
 for(const row of before.sharedDependencies)assert.equal(row.dbid,binding.database,'Foreign database dependency admitted');
 const added=[edge(binding.namespaceCatalog,app.oid),...targets.functions.map(row=>edge(binding.functionCatalog,row.oid)),...targets.relations.map(row=>edge(binding.relationCatalog,row.oid)),...targets.types.map(row=>edge(binding.typeCatalog,row.oid))];
 const baseline=new Set(before.sharedDependencies.map(dependencyKey));for(const row of added)assert(!baseline.has(dependencyKey(row)),'Owner edge already existed before transfer');
 const sort=(rows:AccessSharedDependency[])=>rows.sort((a,b)=>{for(const key of ['dbid','classid','objid','objsubid','refclassid','refobjid']as const)if(a[key]!==b[key])return a[key]-b[key];return Buffer.compare(Buffer.from(a.deptype),Buffer.from(b.deptype));});
 const expected=sort([...before.sharedDependencies,...added]),rawExpected=sort([...before.sharedDependencies,...added.map(row=>({...row,refobjid:binding.newOwner}))]);
 return{kind:'NATIVE_PINNED_TO_RESTRICTED_OWNER_EXPECTATION',binding,pinControl:pin,baselineRows:before.sharedDependencies.length,addedOwnerRows:added.length,
  sourceObjects:{namespace:[app.oid],functions:targets.functions.map(row=>row.oid),relations:targets.relations.map(row=>row.oid),types:targets.types.map(row=>row.oid)},
  rawBeforeSharedDependencies:before.sharedDependencies,expectedAddedOwnerDependencies:added,expectedSharedDependencies:expected,expectedCounter:accessDependencyCounter(expected),expectedRawSharedDependencies:rawExpected,rawExpectedCounter:accessDependencyCounter(rawExpected)};
}
/** Exact multiset equality; order cannot hide a missing, duplicate or foreign edge. */
export function assertAccessOwnerDependencies(expected:ReturnType<typeof accessOwnerDependencyExpectation>,actual:unknown,rawActual:unknown){
 assert.deepEqual(accessDependencyCounter(rawActual),expected.rawExpectedCounter,'Raw native shared dependencies do not bind exact new owner and every baseline edge');
 assert.deepEqual(accessDependencyCounter(actual),expected.expectedCounter,'Complete normalized shared dependencies differ from BEFORE plus exact transferred-owner obligations');
}
