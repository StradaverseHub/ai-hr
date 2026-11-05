import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withRewardsTenant } from '../../core/module-gate';
import type { SessionContext } from '../../db/client';

export const wholeGroupRewardRoles = ['gr', 'ctro', 'ec'] as const;
type WholeGroupRewardRole = (typeof wholeGroupRewardRoles)[number];

export function rewardGroupRoleDirectory(session: SessionContext) {
  return withRewardsTenant(session, tx => tx.execute<{
    userId: string;
    name: string;
    role: WholeGroupRewardRole;
    active: boolean;
    eligible: boolean;
    revision: number;
  }>(sql`
    select user_id as "userId", name, role, active, eligible, revision
    from app.reward_group_role_directory()
  `));
}

export function saveRewardGroupRole(session: SessionContext, raw: unknown) {
  const grant = z.object({
    userId: z.uuid(),
    role: z.enum(wholeGroupRewardRoles),
    active: z.boolean(),
    revision: z.number().int().nonnegative(),
    reason: z.string().trim().min(10).max(2000),
  }).strict().parse(raw);

  return withRewardsTenant(session, tx => tx.execute(sql`
    select app.reward_save_group_role(
      ${grant.userId}::uuid, ${grant.role}, ${grant.active}, ${grant.revision}, ${grant.reason}
    )
  `));
}

export function rewardWholeGroupPlans(session: SessionContext) {
  return withRewardsTenant(session, tx => tx.execute<{
    id: string;
    cycle: string;
    year: number;
    snapshot: string;
    state: 'draft' | 'pending' | 'approved';
    companies: string[];
  }>(sql`
    select plan_id as id, cycle_name as cycle, year, snapshot_date::text as snapshot, state, companies
    from app.reward_whole_group_plan_catalogue()
  `));
}
