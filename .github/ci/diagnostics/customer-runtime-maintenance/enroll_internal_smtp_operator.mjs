/** Explicit operator-controlled staging enrollment. Never changes credential or HR grants. */
import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function validateCandidate(c,b,expected){
 assert(expected.username==='phone-tester'&&expected.organization==='aihr-test'&&expected.origin==='https://onehr-staging.chinhingroup.com','Exact human-selected staging account required');
 assert(c&&c.username===expected.username&&c.organization===expected.organization&&c.enabled===true&&c.emailVerified===true&&c.mustChange===false&&typeof c.password==='string'&&c.password.length>0&&typeof c.totpSecret==='string'&&c.totpSecret.length>0,'Existing verified MFA-ready credential required');
 assert(c.subject===b.subject&&c.issuer===b.issuer&&c.tenantId===b.tenant_id&&b.revoked_at===null&&b.blocked===false&&b.group_admin===true,'Exact active existing group administrator required');
 assert(c.issuer===expected.origin+'/auth/'+c.tenantId,'Current staging internal issuer required');
 if(expected.subject)assert(c.subject===expected.subject&&c.version===expected.credentialVersion&&b.app_user_id===expected.appUserId&&c.email===expected.verifiedEmail,'Reviewed identity changed');
 return{username:c.username,organization:c.organization,subject:c.subject,issuer:c.issuer,tenantId:c.tenantId,appUserId:b.app_user_id,credentialVersion:c.version,verifiedEmail:c.email};
}
export function existingGrantState(rows,c){
 assert(rows.length<=1,'Duplicate operator identity');if(!rows.length)return'absent';
 assert(rows[0].revoked_at===null&&rows[0].test_email.toLowerCase()===c.email.toLowerCase(),'Conflicting or revoked operator grant requires separate review');return'already-enrolled';
}
export async function enroll({db,readRecord,expected,apply,afterInsert=()=>{}}){
 return db.begin(apply?'isolation level serializable':'isolation level repeatable read read only',async tx=>{
  if(apply)await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('installation-smtp-operator:'||$1,0))",[expected.organization+':'+expected.username]);
  const [visibility]=await tx.unsafe("select count(*)=4 and bool_and(not c.relrowsecurity or(c.relowner=current_user::regrole and not c.relforcerowsecurity)or(select rolbypassrls from pg_roles where rolname=current_user)) as allowed from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in('app_external_identity','deployment_identity_operator','app_internal_auth_record','role_assignment')");assert(visibility.allowed,'Unfiltered identity visibility required');
  const key='login:'+hash(expected.organization+'\0'+expected.username),index=await readRecord(tx,key,apply);assert(index?.subject,'Existing selected login required');
  const credentialKey='credential:'+index.subject,c=await readRecord(tx,credentialKey,apply);assert(c?.subject===index.subject);
  const rows=await tx.unsafe("select i.issuer,i.subject,i.app_user_id,i.revoked_at,u.tenant_id,app.login_blocked(u.id) blocked,exists(select 1 from role_assignment r where r.app_user_id=u.id and r.company_id is null and r.role in('hr_admin','super_admin')) group_admin from app_external_identity i join app_user u on u.id=i.app_user_id where i.issuer=$1 and i.subject=$2"+(apply?' for update of i,u':''),[c.issuer,c.subject]);assert(rows.length===1);const candidate=validateCandidate(c,rows[0],expected);
  const existing=await tx.unsafe('select test_email,revoked_at from deployment_identity_operator where issuer=$1 and subject=$2'+(apply?' for update':''),[c.issuer,c.subject]);const state=existingGrantState(existing,c);
  const snapshot=async()=>{const credentials=await tx.unsafe('select record_key,sealed,expires_at,updated_at from app_internal_auth_record where record_key=$1 or record_key=$2 order by record_key',[key,credentialKey]);const roles=await tx.unsafe('select * from role_assignment where app_user_id=$1::uuid order by id',[candidate.appUserId]);const bindings=await tx.unsafe('select * from app_external_identity where app_user_id=$1::uuid order by issuer,subject',[candidate.appUserId]);const others=await tx.unsafe('select * from deployment_identity_operator where issuer<>$1 or subject<>$2 order by issuer,subject',[c.issuer,c.subject]);return{credentialSha256:hash(JSON.stringify(credentials)),roleSha256:hash(JSON.stringify(roles)),bindingSha256:hash(JSON.stringify(bindings)),otherOperatorsSha256:hash(JSON.stringify(others))};};
  const before=await snapshot();
  if(!apply)return{kind:'READ_ONLY_STAGING_SMTP_OPERATOR_PROPOSAL',candidate,state,custody:before,changes:{insertOperatorGrant:state==='absent',appendAuditEvent:state==='absent',password:false,mfa:false,hrRoles:false,legacyOperator:false,emailSend:false,production:false},readOnly:true};
  assert(expected.humanApprovalReference,'Specific human approval required');
  if(state==='absent'){
   const inserted=await tx.unsafe('insert into deployment_identity_operator(issuer,subject,test_email) values($1,$2,$3) returning issuer',[c.issuer,c.subject,c.email]);assert(inserted.length===1);
   await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.identity-email-enrolled','system',null,$3::jsonb)",[c.tenantId,candidate.appUserId,JSON.stringify({via:'operator-controlled-installation',provider:'internal',environment:'staging',humanApprovalReference:expected.humanApprovalReference})]);
   await afterInsert();
  }
  await tx.unsafe("select set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[c.tenantId,candidate.appUserId]);
  const [authorized]=await tx.unsafe('select app.internal_auth_email_operator($1,$2,$3) allowed',[c.issuer,c.subject,c.email]);assert(authorized.allowed===true,'Canonical SMTP authorization refused');
  const after=await snapshot();assert.deepEqual(after,before,'Credential, HR role, identity binding or legacy operator changed');
  return{kind:'STAGING_INTERNAL_SMTP_OPERATOR_ENROLLED',username:c.username,organization:c.organization,created:state==='absent',canonicalEmailAuthorizationVerified:true,credentialsMfaRolesAndLegacyOperatorPreserved:true,custody:after,emailSent:false,productionChanged:false};
 });
}
async function main(){
 const expected=JSON.parse(readFileSync(0,'utf8')),apply=process.env.AIHR_ENROLL_ENTRY==='apply';
 assert(process.platform==='linux'&&process.versions.node==='22.23.3'&&process.cwd()==='/opt/ai-hr');assert(process.env.AUTH_PROVIDER==='internal'&&process.env.AUTH_PUBLIC_ORIGIN===expected.origin);
 if(apply){assert(process.getuid()===1000);const parent=readFileSync('/proc/'+process.ppid+'/status','utf8').match(/^Uid:\s+(\d+)\s+(\d+)/m);assert(parent&&parent[1]==='0'&&parent[2]==='0','Root-controlled enrollment required');}
 const config=await import('./lib/internal-auth/record-store.ts');const{readRecord}=config.default??config;const postgres=(await import('postgres')).default;const db=postgres(process.env.MIGRATION_DATABASE_URL,{max:1,connect_timeout:10,idle_timeout:1,onnotice:()=>{}});
 try{console.log(JSON.stringify(await enroll({db,readRecord,expected,apply})));}catch{console.error('STAGING_SMTP_OPERATOR_ENROLLMENT_REFUSED_NO_PARTIAL_GRANT');process.exitCode=1;}finally{await db.end({timeout:2});}
}
if(process.env.AIHR_ENROLL_ENTRY==='preview'||process.env.AIHR_ENROLL_ENTRY==='apply')await main();
