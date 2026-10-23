/** Independent exact current Profile scope (0560 insert/delete, 0571 routed read/update and
 * the additive 0579 restrictive review gates), held
 * constant on both sides of historical 0515 comparisons; named routing is not legacy equivalence. */
import {expect} from 'vitest';
import {owner} from './harness';
type Row=Record<string,unknown>;
type PolicyConnection=Pick<typeof owner.client,'unsafe'>;
type CurrentProfilePolicy={policy:string;cmd:'SELECT'|'INSERT'|'UPDATE'|'DELETE';qual:string|null;withCheck:string|null;roles?:string[];permissive?:'RESTRICTIVE'};
export const profileHistoricalPolicyKey='profile_change_request.profile_change_request_rls';
// Independent expected clauses, never loaded from the migration being checked.
const currentProfilePolicies:CurrentProfilePolicy[]=[
  {
    policy:'access_profile_review_read',cmd:'SELECT',roles:['ai_hr_app'],permissive:'RESTRICTIVE',
    qual:'app.access_profile_request_own(person_id) OR app.access_profile_review_permitted(employment_id)',withCheck:null,
  },
  {
    policy:'access_profile_review_update',cmd:'UPDATE',roles:['ai_hr_app'],permissive:'RESTRICTIVE',
    qual:'app.access_profile_review_permitted(employment_id)',withCheck:'app.access_profile_review_permitted(employment_id)',
  },
  {
    "policy": "profile_change_request_read",
    "cmd": "SELECT",
    "qual": "tenant_id=app.current_tenant_id() AND EXISTS (SELECT 1 FROM employment e WHERE e.id=profile_change_request.employment_id AND e.tenant_id=profile_change_request.tenant_id AND e.person_id=profile_change_request.person_id AND (app.is_self_person(e.person_id) OR app.profile_route_reader(e.id,profile_change_request.route_approver_user_id,profile_change_request.route_approver_employment_id,profile_change_request.status::text)))",
    "withCheck": null
  },
  {
    "policy": "profile_change_request_insert",
    "cmd": "INSERT",
    "qual": null,
    "withCheck": "tenant_id=app.current_tenant_id() AND EXISTS (SELECT 1 FROM employment e WHERE e.id=profile_change_request.employment_id AND e.person_id=profile_change_request.person_id AND e.tenant_id=profile_change_request.tenant_id AND (app.can_admin_employment(e.id) OR (app.is_self_person(e.person_id) AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=e.tenant_id AND u.person_id=e.person_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) AND profile_change_request.status='pending' AND profile_change_request.decided_at IS NULL AND profile_change_request.decided_by_employment_id IS NULL)))"
  },
  {
    "policy": "profile_change_request_update",
    "cmd": "UPDATE",
    "qual": "tenant_id=app.current_tenant_id() AND app.profile_route_reader(employment_id,route_approver_user_id,route_approver_employment_id,status::text)",
    "withCheck": "tenant_id=app.current_tenant_id() AND app.profile_route_reader(employment_id,route_approver_user_id,route_approver_employment_id,status::text)"
  },
  {
    "policy": "profile_change_request_delete",
    "cmd": "DELETE",
    "qual": "tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)",
    "withCheck": null
  }
];
export async function currentProfilePolicySnapshot(connection:PolicyConnection=owner.client):Promise<Row[]>{
  return await connection.unsafe(`select tablename,policyname,qual,with_check,cmd,roles,permissive from pg_policies
    where schemaname='public' and tablename='profile_change_request' order by policyname`) as unknown as Row[];
}
export async function assertCurrentProfilePolicyGraph(){
  const snapshot=await currentProfilePolicySnapshot();
  expect(snapshot.map(r=>r.policyname),'exact current Profile policy set').toEqual(currentProfilePolicies.map(p=>p.policy).sort());
  expect(snapshot.some(r=>r.policyname==='profile_change_request_rls'),'retired Profile ALL policy is absent').toBe(false);
  const rollback=new Error('Current Profile policy normalization rollback');
  try{
    await owner.client.begin(async tx=>{
      for(const p of currentProfilePolicies){
        const actual=snapshot.find(r=>r.policyname===p.policy);
        expect(actual,`${p.policy} exists`).toBeTruthy();
        expect(actual!.cmd,`${p.policy} command`).toBe(p.cmd);
        expect(actual!.roles,`${p.policy} roles`).toEqual(p.roles??['public']);
        expect(actual!.permissive,`${p.policy} permissive mode`).toBe(p.permissive??'PERMISSIVE');
        const clauses=[p.qual===null?'':`USING (${p.qual})`,p.withCheck===null?'':`WITH CHECK (${p.withCheck})`].filter(Boolean).join(' ');
        expect(clauses.length,`${p.policy} independent expected expression is nonempty`).toBeGreaterThan(20);
        await tx.unsafe(`alter policy "${p.policy}" on public.profile_change_request ${clauses}`);
        const parsed=await tx.unsafe(`select qual,with_check from pg_policies where schemaname='public' and tablename='profile_change_request' and policyname=$1`,[p.policy]);
        expect(parsed,`${p.policy} normalized policy`).toHaveLength(1);
        expect(actual!.qual??null,`${p.policy} exact USING`).toBe(p.qual===null?null:parsed[0].qual);
        expect(actual!.with_check??null,`${p.policy} exact WITH CHECK`).toBe(p.withCheck===null?null:parsed[0].with_check);
      }
      throw rollback;
    });
  }catch(error){if(error!==rollback)throw error;}
  return snapshot;
}
