/** Actual fixed native seam only. Root must register its closed sole outer owner
 * before execution; no ordinary/shared-file or release qualification is claimed. */
import {afterAll,expect,it,type TestContext} from 'vitest';
import {owner} from './harness';
import {employeeChoiceNativeObjectOid} from './performance/employee-choice-native-object-identity';
import {employeeChoiceNativeCaseOwner} from './performance/employee-choice-native-case-owner';
import {admitEmployeeChoiceNativeFactory,employeeChoiceNativeFactoryFixture,type FactoryStatement} from './performance/employee-choice-native-factory-fixture';
import {employeeChoiceNativePrototypeOwner,employeeChoicePrototypeSignature,type EmployeeChoiceNativeInstallation} from './performance/employee-choice-native-purpose-owner-factory';
import {employeeChoiceNativeSecurity,installEmployeeChoiceNativePrototype} from './performance/employee-choice-native-purpose-owner';
admitEmployeeChoiceNativeFactory();
const cases=employeeChoiceNativeCaseOwner();afterAll(()=>cases.drain());
type Fixture=ReturnType<typeof employeeChoiceNativeFactoryFixture>;
let legacy:{full:Record<string,unknown>;security:EmployeeChoiceNativeInstallation['security'];trace:FactoryStatement[];oid:string}|undefined;
const metadata=(resource:EmployeeChoiceNativeInstallation)=>{
 const full=Object.fromEntries(Object.entries(resource.installed));
 expect(Object.keys(full).sort()).toEqual(['acl_count','app','definition','identity','owner','proconfig','proisstrict','prokind','proleakproof','pronargs','proparallel','prosecdef','provolatile','public']);
 const identity=resource.installed.identity;if(!identity||typeof identity!=='object'||Array.isArray(identity))throw Error('Complete native pg_proc identity required');
 const fields=Object.fromEntries(Object.entries(identity)),oid=employeeChoiceNativeObjectOid(fields.oid);
 // Two separately CREATEd owned functions necessarily have different OIDs.
 // Retain each full native record; compare EVERY other field without opaque
 // catalogue normalization, owner/ACL waiver or invented equality.
 const {oid:actualOid,...rest}=fields;expect(employeeChoiceNativeObjectOid(actualOid)).toBe(oid);full.identity=rest;
 expect(resource.sourceSha256).toBe('d72e6ded4a07cbbb848856c35391e1e56fdd02ad793c71a18360754e11fe8efc');return{full,oid};
};
async function facts(scope:Fixture){
 const [row]=await scope.getQuery()`select md5(jsonb_build_object('person',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb)from person p),
  'employment',(select coalesce(jsonb_agg(to_jsonb(e)order by e.id),'[]'::jsonb)from employment e),
  'assignment',(select coalesce(jsonb_agg(to_jsonb(a)order by a.id),'[]'::jsonb)from assignment a),
  'events',(select coalesce(jsonb_agg(to_jsonb(e)order by e.id),'[]'::jsonb)from domain_event e))::text)as hash`;
 return row.hash;
}
function controlled(context:TestContext,work:(scope:Fixture,adopt:(resource:EmployeeChoiceNativeInstallation)=>void)=>Promise<void>,defaultBinding=false){
 return cases.run(context,async owned=>{
  const scope=employeeChoiceNativeFactoryFixture(owned.signal,owned.cleanupDeadline),resources:EmployeeChoiceNativeInstallation[]=[];
  const original=owner.client;let primary:unknown,before:string|undefined;
  try{await scope.identity();before=await facts(scope);if(defaultBinding)owner.client=scope.workSql;await work(scope,resource=>{resources.push(resource);});}
  catch(error){primary=error;throw error;}
  finally{
   const errors:unknown[]=[];
   try{owned.enterCleanup();await scope.beginCleanup();if(defaultBinding)owner.client=scope.getQuery();}catch(error){errors.push(error);}
   for(const resource of resources.reverse())try{await resource.remove();}catch(error){errors.push(error);}
   try{expect(scope.statements.filter(row=>row.carrier==='cleanup'&&row.text==='drop function '+employeeChoicePrototypeSignature)).toHaveLength(1);}catch(error){errors.push(error);}
   try{expect((await scope.getQuery()`select to_regprocedure(${employeeChoicePrototypeSignature})as present`)[0].present).toBeNull();if(before!==undefined)expect(await facts(scope)).toBe(before);}catch(error){errors.push(error);}
   try{await scope.close();}catch(error){errors.push(error);}finally{if(defaultBinding)owner.client=original;}
   if(errors.length){if(primary!==undefined)errors.unshift(primary);const error=new AggregateError(errors,'Native factory restoration or ownership refused');cases.poison(error);throw error;}
  }
 });
}
it('preserves the legacy dynamic default wrapper and every metadata/security/query field with actual bounded native carriers',context=>controlled(context,async(scope,adopt)=>{
 const before=await employeeChoiceNativeSecurity(),start=scope.statements.length;
 const resource=await installEmployeeChoiceNativePrototype(adopt);expect(resource.security).toEqual(before);await resource.unchanged();
 const txSecurity=scope.statements.slice(start).filter(row=>row.carrier==='tx'&&/select p\.oid::regprocedure|select schemaname,tablename|select table_schema,table_name|select \* from pg_auth_members/.test(row.text));
 expect(txSecurity).toHaveLength(4);const value=metadata(resource);
 legacy={...value,security:resource.security,trace:scope.statements.slice(start)};
},true));
it('uses the SAME actual max1 transaction for full security checks and matches the complete legacy result/SQL vector',context=>controlled(context,async(scope,adopt)=>{
 if(!legacy)throw Error('Independent legacy native vector missing');
 await scope.heldTransactionRefusal();const bound=employeeChoiceNativePrototypeOwner(scope.getQuery),before=await bound.security(),start=scope.statements.length;
 const resource=await bound.install(adopt);await resource.unchanged();const value=metadata(resource);
 expect(value.oid).not.toBe(legacy.oid);expect(value.full).toEqual(legacy.full);expect(resource.security).toEqual(legacy.security);expect(before).toEqual(legacy.security);
 expect(scope.statements.slice(start)).toEqual(legacy.trace);
}));
it('owns preCOMMIT rollback/lost-delivery witnesses and refuses altered native metadata before exact guarded removal',context=>controlled(context,async(scope,adopt)=>{
 const bound=employeeChoiceNativePrototypeOwner(scope.getQuery),rollback=Error('Fixed rollback after actual native witness');let rolledBack:EmployeeChoiceNativeInstallation|undefined;
 await expect(bound.install(resource=>{adopt(resource);rolledBack=resource;throw rollback;})).rejects.toBe(rollback);expect(rolledBack).toBeDefined();await rolledBack!.remove();
 let committed:EmployeeChoiceNativeInstallation|undefined;
 await expect((async()=>{await bound.install(resource=>{adopt(resource);committed=resource;});throw Error('Fixed undelivered result after native COMMIT');})()).rejects.toThrow('undelivered');
 if(!committed)throw Error('PreCOMMIT native witness was not adopted');await committed.unchanged();
 await scope.getQuery().unsafe('alter function '+employeeChoicePrototypeSignature+' set jit=on');
 try{await expect(committed.remove()).rejects.toThrow();expect((await scope.getQuery()`select to_regprocedure(${employeeChoicePrototypeSignature})is not null as present`)[0].present).toBe(true);}
 finally{await scope.getQuery().unsafe('alter function '+employeeChoicePrototypeSignature+' set jit=off');}
 await committed.unchanged();
}));
