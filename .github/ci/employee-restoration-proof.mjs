/** Pure closed observation codec. No native query, authority or receipt factory. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const employeeRestorationHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys=(value,names)=>assert(value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...names].sort()),'Closed restoration observation required');
export const employeePlanLoggingChanges=Object.freeze({session_preload_libraries:'auto_explain','auto_explain.log_min_duration':'0','auto_explain.log_parameter_max_length':'0','auto_explain.log_analyze':'on','auto_explain.log_buffers':'on','auto_explain.log_settings':'on','auto_explain.log_format':'json','auto_explain.log_timing':'off','auto_explain.log_nested_statements':'on','auto_explain.sample_rate':'1'});
const digest=value=>assert(typeof value==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(value),'Exact restoration digest required');
function oid(value,zero=false){assert(typeof value==='number'&&Number.isSafeInteger(value)&&value>=(zero?0:1)&&value<=4294967295||typeof value==='string'&&/^(?:0|[1-9][0-9]{0,9})(?![\s\S])/.test(value)&&BigInt(value)>=BigInt(zero?0:1)&&BigInt(value)<=BigInt('4294967295'),'Exact native OID required');return String(value);}
export function employeeRestorationIdentity(value,database){keys(value,['role','login','database','loopback','databaseOid']);oid(value.databaseOid);assert.equal(value.role,'postgres');assert.equal(value.login,'postgres');assert.equal(value.database,database);assert.equal(value.loopback,true);assert(typeof database==='string'&&/^ai_hr_test_w(?:_[a-z0-9_]{1,20})?[1-9][0-9]*(?![\s\S])/.test(database));}
export function employeeLoggingNativeRow(value){
 if(value===null)return null;
 keys(value,['setdatabase','setrole','setconfig']);oid(value.setdatabase);assert.equal(oid(value.setrole,true),'0');assert(Array.isArray(value.setconfig)&&value.setconfig.every(entry=>typeof entry==='string'&&entry.indexOf('=')>0));
 const names=value.setconfig.map(entry=>entry.slice(0,entry.indexOf('=')));assert.equal(new Set(names).size,names.length,'Duplicate native database setting');return value;
}
const config=value=>value===null?[]:employeeLoggingNativeRow(value).setconfig;
function security(value){keys(value,['functions','policies','grants','roleEdges']);assert(Object.values(value).every(Array.isArray)&&value.functions.length>0);return Object.fromEntries(Object.entries(value).map(([name,rows])=>[name,rows.length]));}
export function verifyEmployeePrototypeRestoration(value,{database,sourceSha256,installedSha256,securitySha256}){
 keys(value,['version','kind','database','identity','sourceSha256','installed','installedSha256','beforeSecurity','afterSecurity','beforeSecuritySha256','afterSecuritySha256','securityCounts','signatureAbsent','overloads']);
 assert.equal(value.version,1);assert.equal(value.kind,'NATIVE_EMPLOYEE_PROTOTYPE_RESTORATION_NOT_RELEASE');assert.equal(value.database,database);employeeRestorationIdentity(value.identity,database);
 for(const d of [sourceSha256,installedSha256,securitySha256,value.installedSha256,value.beforeSecuritySha256,value.afterSecuritySha256])digest(d);
 assert.equal(value.sourceSha256,sourceSha256);assert.equal(value.installedSha256,installedSha256);assert.equal(employeeRestorationHash(value.installed),installedSha256);
 keys(value.installed,['acl_count','app','definition','identity','owner','proconfig','proisstrict','prokind','proleakproof','pronargs','proparallel','prosecdef','provolatile','public']);
 assert(typeof value.installed.definition==='string'&&value.installed.definition.length>0&&value.installed.identity&&typeof value.installed.identity==='object'&&!Array.isArray(value.installed.identity));oid(value.installed.identity.oid);oid(value.installed.identity.proowner);
 assert.equal(value.installed.owner,'postgres');assert.equal(value.installed.app,true);assert.equal(value.installed.public,false);assert.equal(value.installed.acl_count,2);assert.equal(value.installed.identity.proname,'employee_choice_native_prototype');assert(typeof value.installed.identity.prosrc==='string'&&value.installed.identity.prosrc.length>0);
 for(const [key,expected]of Object.entries({prosecdef:false,provolatile:'s',proparallel:'u',proconfig:['search_path=pg_catalog, pg_temp','jit=off'],pronargs:20,proisstrict:false,proleakproof:false,prokind:'f'})){assert(isDeepStrictEqual(value.installed[key],expected));assert(isDeepStrictEqual(value.installed.identity[key],expected));}
 assert.equal(employeeRestorationHash(value.beforeSecurity),securitySha256);assert.equal(value.beforeSecuritySha256,securitySha256);assert.equal(employeeRestorationHash(value.afterSecurity),value.afterSecuritySha256);assert.equal(value.afterSecuritySha256,securitySha256);
 assert(isDeepStrictEqual(value.beforeSecurity,value.afterSecurity));assert(isDeepStrictEqual(security(value.beforeSecurity),value.securityCounts));assert(isDeepStrictEqual(security(value.afterSecurity),value.securityCounts));
 assert.equal(value.signatureAbsent,true);assert.equal(value.overloads,0);return value;
}
export function verifyEmployeeLoggingRestoration(value,{database,beforeSha256,instrumentedSha256}){
 keys(value,['version','kind','database','identity','before','instrumented','after','beforeSha256','instrumentedSha256','beforeNativeSha256','instrumentedNativeSha256','afterNativeSha256']);
 assert.equal(value.version,1);assert.equal(value.kind,'NATIVE_EMPLOYEE_LOGGING_RESTORATION_NOT_RELEASE');assert.equal(value.database,database);employeeRestorationIdentity(value.identity,database);
 for(const d of [beforeSha256,instrumentedSha256,value.beforeNativeSha256,value.instrumentedNativeSha256,value.afterNativeSha256])digest(d);
 employeeLoggingNativeRow(value.before);employeeLoggingNativeRow(value.instrumented);employeeLoggingNativeRow(value.after);assert(value.instrumented!==null);assert(value.before===null||value.before.setconfig.length>0,'Unsupported pre-existing empty native setting row');
 if(value.before!==null)assert.equal(oid(value.before.setdatabase),oid(value.instrumented.setdatabase));assert.equal(oid(value.instrumented.setdatabase),oid(value.identity.databaseOid));
 const expected=[...config(value.before)];for(const [key,setting]of Object.entries(employeePlanLoggingChanges)){const index=expected.findIndex(entry=>entry.startsWith(key+'='));if(index<0)expected.push(key+'='+setting);else expected[index]=key+'='+setting;}assert(isDeepStrictEqual(value.instrumented.setconfig,expected),'Exact source-owned instrumentation vector required');
 assert.equal(value.beforeSha256,beforeSha256);assert.equal(employeeRestorationHash(config(value.before)),beforeSha256);assert.equal(value.instrumentedSha256,instrumentedSha256);assert.equal(employeeRestorationHash(config(value.instrumented)),instrumentedSha256);
 for(const [key,row]of [['beforeNativeSha256',value.before],['instrumentedNativeSha256',value.instrumented],['afterNativeSha256',value.after]])assert.equal(employeeRestorationHash(row),value[key]);
 assert(isDeepStrictEqual(value.before,value.after),'Exact native setting row, including absence, must restore');return value;
}
