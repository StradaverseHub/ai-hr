/** Native fixture ownership facts. No installer, connection creation or app writer. */
import assert from 'node:assert/strict';
import type postgres from 'postgres';
export type NativeBridgeConnection=Pick<postgres.Sql,'unsafe'>;
export type RoleRecord={oid:number;facts:Record<string,unknown>};
export type OwnerSnapshot={state:{role:RoleRecord|null;memberships:Record<string,unknown>[];request:{owner:string;ownerOid:number};
 functions:{oid:number;signature:string;owner:string;facts:Record<string,unknown>}[];bindings:Record<string,unknown>[]};body:string};
export const quoteBridgeRole=(name:string)=>{assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));return '"'+name+'"';};
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
export const BRIDGE_SNAPSHOT=`jsonb_build_object('state',jsonb_build_object(
 'role',(select jsonb_build_object('oid',r.oid::integer,'facts',to_jsonb(r)-'rolpassword') from pg_roles r where rolname=$1),
 'memberships',(select coalesce(jsonb_agg(to_jsonb(m) order by roleid,member,grantor),'[]'::jsonb) from pg_auth_members m
  where roleid=(select oid from pg_roles where rolname=$1) or member=(select oid from pg_roles where rolname=$1)),
 'request',(select jsonb_build_object('oid',c.oid::integer,'ownerOid',c.relowner::integer,'owner',pg_get_userbyid(c.relowner),
  'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'kind',c.relkind) from pg_class c where c.oid='public.attendance_workflow_request'::regclass),
 'functions',(select jsonb_agg(jsonb_build_object('oid',p.oid::integer,'signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
  'facts',case when p.oid='app.attendance_workflow_links()'::regprocedure then to_jsonb(p)-'prosrc' else to_jsonb(p) end) order by p.oid)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.prosecdef and p.prokind='f'),
 'bindings',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where tgfoid='app.attendance_workflow_links()'::regprocedure)),
 'body',(select prosrc from pg_proc where oid='app.attendance_workflow_links()'::regprocedure))`;
export async function bridgeSnapshot(connection:NativeBridgeConnection,role:string){
 const [row]=await connection.unsafe<{snapshot:OwnerSnapshot}[]>(`select ${BRIDGE_SNAPSHOT} as snapshot`,[role]);
 assert(row?.snapshot?.state);assert(Buffer.byteLength(JSON.stringify(row.snapshot))<=16*1024**2);
 assert(row.snapshot.state.functions.length>5);assert.equal(row.snapshot.state.bindings.length,4);
 return row.snapshot;
}
export function assertCreatedRole(snapshot:OwnerSnapshot,parentOid:number){
 const role=snapshot.state.role;assert(role&&Number.isSafeInteger(role.oid)&&role.oid>0);
 for(const key of ['rolsuper','rolbypassrls','rolcanlogin','rolcreatedb','rolcreaterole','rolreplication'])assert.equal(role.facts[key],false);
 assert.equal(role.facts.rolinherit,true);assert.equal(snapshot.state.request.ownerOid,role.oid);
 assert(snapshot.state.functions.every(fn=>Number(fn.facts.proowner)===role.oid));
 assert.equal(snapshot.state.memberships.length,1);const membership=snapshot.state.memberships[0];
 assert.equal(Number(membership.roleid),parentOid);assert.equal(Number(membership.member),role.oid);
 assert.equal(membership.inherit_option,true);assert.equal(membership.set_option,false);assert.equal(membership.admin_option,false);
}
export function assertOwnedRole(current:OwnerSnapshot,witness:OwnerSnapshot,bodies:readonly string[]){
 assert(witness.state.role,'Native created role OID witness required');
 assert.deepEqual(current.state,witness.state,'Unknown native role, membership or owned-object state');
 assert(bodies.includes(current.body),'Unknown native trigger body');
}
export function guardedOwnerBatch(role:string,commands:string[],witness?:OwnerSnapshot,bodies:readonly string[]=[],rolledBack?:OwnerSnapshot){
 assert(/^bridge_owner_[a-f0-9]{32}$/.test(role));
 let guard='';
 if(witness){
  assert(witness.state.role&&bodies.length>0&&bodies.length<=2);const expected=JSON.stringify(witness.state);assert(Buffer.byteLength(expected)<=16*1024**2);
  const snapshot=BRIDGE_SNAPSHOT.replaceAll('$1',literal(role));
  guard=`IF (${snapshot})->'state' IS DISTINCT FROM ${literal(expected)}::jsonb
   OR NOT ((${snapshot})->>'body'=ANY(ARRAY[${bodies.map(literal).join(',')}]))
   THEN RAISE EXCEPTION 'Exact owned native role and object witness required' USING ERRCODE='55000'; END IF;\n`;
 }
 const statements=commands.map(command=>'EXECUTE '+literal(command)+';').join('\n');
 let body=guard+statements;
 if(rolledBack){
  assert(witness&&rolledBack.state.role===null);const expected=JSON.stringify(rolledBack);assert(Buffer.byteLength(expected)<=16*1024**2);
  const snapshot=BRIDGE_SNAPSHOT.replaceAll('$1',literal(role));
  body=`IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(role)}) THEN
   IF (${snapshot}) IS DISTINCT FROM ${literal(expected)}::jsonb THEN RAISE EXCEPTION 'Exact native rollback state required' USING ERRCODE='55000'; END IF;
   ELSE\n${body}\nEND IF;`;
 }
 assert(!body.includes('$bridge_owner_control$'));
 return 'DO $bridge_owner_control$ BEGIN\n'+body+'\nEND; $bridge_owner_control$;';
}
