/** Exact current 0561 Feedback graph, held constant while historical 0515 clauses are compared. */
import { expect } from 'vitest';
import { owner } from './harness';
type Row=Record<string,unknown>;
type PolicyConnection=Pick<typeof owner.client,'unsafe'>;
type TestingFeedbackPolicy={table:string;policy:string;cmd:'SELECT'|'INSERT'|'UPDATE'|'DELETE';qual:string|null;withCheck:string|null};
const key=(table:string,policy:string)=>`${table}.${policy}`;
// Independent expected clauses: never read expected SQL out of the migration under test.
const testingFeedbackPolicies:TestingFeedbackPolicy[]=[
  {
    "table": "feedback_request",
    "policy": "feedback_request_read",
    "cmd": "SELECT",
    "qual": "tenant_id=app.current_tenant_id() AND CASE WHEN reporter_employment_id IS NOT NULL THEN reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) ELSE (SELECT app.feedback_live_principal()) AND (reporter_user_id=app.current_user_id() OR app.is_group_admin()) END",
    "withCheck": null
  },
  {
    "table": "feedback_request",
    "policy": "feedback_request_insert",
    "cmd": "INSERT",
    "qual": null,
    "withCheck": "tenant_id=app.current_tenant_id() AND CASE WHEN reporter_employment_id IS NOT NULL THEN reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) ELSE reporter_user_id=app.current_user_id() AND (SELECT app.feedback_live_principal()) END"
  },
  {
    "table": "feedback_request",
    "policy": "feedback_request_update",
    "cmd": "UPDATE",
    "qual": "app.can_access_feedback(id)",
    "withCheck": "tenant_id=app.current_tenant_id() AND CASE WHEN reporter_employment_id IS NOT NULL THEN reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) ELSE (SELECT app.feedback_live_principal()) AND (reporter_user_id=app.current_user_id() OR app.is_group_admin()) END"
  },
  {
    "table": "feedback_request",
    "policy": "feedback_request_delete",
    "cmd": "DELETE",
    "qual": "tenant_id=app.current_tenant_id() AND reporter_employment_id IS NOT NULL AND reporter_employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])",
    "withCheck": null
  },
  {
    "table": "feedback_attachment",
    "policy": "feedback_attachment_read",
    "cmd": "SELECT",
    "qual": "tenant_id=app.current_tenant_id() AND CASE WHEN employment_id IS NOT NULL THEN employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) ELSE app.can_access_feedback(feedback_request_id) END",
    "withCheck": null
  },
  {
    "table": "feedback_attachment",
    "policy": "feedback_attachment_insert",
    "cmd": "INSERT",
    "qual": null,
    "withCheck": "tenant_id=app.current_tenant_id() AND CASE WHEN employment_id IS NOT NULL THEN employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) ELSE app.can_access_feedback(feedback_request_id) AND uploaded_by_user_id=app.current_user_id() AND (SELECT app.feedback_live_principal()) END"
  },
  {
    "table": "feedback_attachment",
    "policy": "feedback_attachment_update",
    "cmd": "UPDATE",
    "qual": "tenant_id=app.current_tenant_id() AND employment_id IS NOT NULL AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])",
    "withCheck": "tenant_id=app.current_tenant_id() AND employment_id IS NOT NULL AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])"
  },
  {
    "table": "feedback_attachment",
    "policy": "feedback_attachment_delete",
    "cmd": "DELETE",
    "qual": "tenant_id=app.current_tenant_id() AND employment_id IS NOT NULL AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])",
    "withCheck": null
  },
  {
    "table": "feedback_block",
    "policy": "feedback_block_read",
    "cmd": "SELECT",
    "qual": "tenant_id=app.current_tenant_id() AND app.can_access_feedback(feedback_request_id)",
    "withCheck": null
  },
  {
    "table": "feedback_plan_revision",
    "policy": "feedback_plan_revision_read",
    "cmd": "SELECT",
    "qual": "tenant_id=app.current_tenant_id() AND app.can_access_feedback(feedback_request_id)",
    "withCheck": null
  },
  {
    "table": "feedback_plan_revision",
    "policy": "feedback_plan_revision_append",
    "cmd": "INSERT",
    "qual": null,
    "withCheck": "tenant_id=app.current_tenant_id() AND outcome IS NULL AND app.can_access_feedback(feedback_request_id)"
  },
  {
    "table": "feedback_plan_revision",
    "policy": "feedback_plan_revision_close",
    "cmd": "UPDATE",
    "qual": "tenant_id=app.current_tenant_id() AND outcome IS NULL AND app.can_access_feedback(feedback_request_id)",
    "withCheck": "tenant_id=app.current_tenant_id() AND app.can_access_feedback(feedback_request_id)"
  },
  {
    "table": "feedback_block",
    "policy": "feedback_block_append",
    "cmd": "INSERT",
    "qual": null,
    "withCheck": "tenant_id=app.current_tenant_id() AND resolved_at IS NULL AND answer IS NULL AND app.can_access_feedback(feedback_request_id)"
  },
  {
    "table": "feedback_block",
    "policy": "feedback_block_resolve",
    "cmd": "UPDATE",
    "qual": "tenant_id=app.current_tenant_id() AND resolved_at IS NULL AND app.can_access_feedback(feedback_request_id)",
    "withCheck": "tenant_id=app.current_tenant_id() AND resolved_at IS NOT NULL AND app.can_access_feedback(feedback_request_id)"
  }
];
export const testingFeedbackHistoricalKeys=new Set([
  'feedback_attachment.feedback_attachment_rls','feedback_request.feedback_request_rls',
  'feedback_block.feedback_block_read','feedback_plan_revision.feedback_plan_revision_read',
]);
export async function currentFeedbackPolicySnapshot(connection:PolicyConnection=owner.client):Promise<Row[]> {
  return await connection.unsafe(`select tablename,policyname,qual,with_check,cmd,roles,permissive from pg_policies
    where schemaname='public' and tablename IN ('feedback_attachment','feedback_request','feedback_block','feedback_plan_revision') order by tablename,policyname`) as unknown as Row[];
}
export async function assertTestingFeedbackPolicyGraph() {
  const snapshot=await currentFeedbackPolicySnapshot();
  expect(snapshot.map(r=>key(String(r.tablename),String(r.policyname))), 'exact current Feedback policy set')
    .toEqual(testingFeedbackPolicies.map(p=>key(p.table,p.policy)).sort());
  const live=new Map(snapshot.map(r=>[key(String(r.tablename),String(r.policyname)),r] as const));
  expect(live.has('feedback_attachment.feedback_attachment_rls'),'retired attachment ALL policy absent').toBe(false);
  expect(live.has('feedback_request.feedback_request_rls'),'retired request ALL policy absent').toBe(false);
  const rollback=new Error('0561 Feedback policy normalization rollback');
  try {
    await owner.client.begin(async tx=>{
      for(const p of testingFeedbackPolicies){
        const label=key(p.table,p.policy),actual=live.get(label);
        expect(actual,`${label} exists`).toBeTruthy();
        expect(actual!.cmd,`${label} command`).toBe(p.cmd);
        expect(actual!.roles,`${label} roles`).toEqual(['public']);
        expect(actual!.permissive,`${label} permissive mode`).toBe('PERMISSIVE');
        const clauses=[p.qual===null?'':`USING (${p.qual})`,p.withCheck===null?'':`WITH CHECK (${p.withCheck})`].filter(Boolean).join(' ');
        expect(clauses.length,`${label} independent expected expression is nonempty`).toBeGreaterThan(20);
        await tx.unsafe(`alter policy "${p.policy}" on public."${p.table}" ${clauses}`);
        const parsed=await tx.unsafe(`select qual,with_check from pg_policies where schemaname='public' and tablename=$1 and policyname=$2`,[p.table,p.policy]);
        expect(parsed,`${label} normalized policy`).toHaveLength(1);
        expect(actual!.qual??null,`${label} exact USING`).toBe(p.qual===null?null:parsed[0].qual);
        expect(actual!.with_check??null,`${label} exact WITH CHECK`).toBe(p.withCheck===null?null:parsed[0].with_check);
      }
      throw rollback;
    });
  }catch(error){if(error!==rollback)throw error;}
  return snapshot;
}
