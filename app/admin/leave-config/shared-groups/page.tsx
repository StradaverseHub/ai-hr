import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes } from '@/core/read';
import { listLeaveSharedGroups } from '@/core/leave-shared-group';
import { ErrorBanner, PageHeader, btnPrimary } from '@/components/ui';
import { LeaveSharedGroupConfig } from '@/components/leave-shared-group-config';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import {
  createLeaveSharedGroupAction,
  deleteLeaveSharedGroupAction,
  updateLeaveSharedGroupAction,
} from '../../actions';

/**
 * 50d9b809 — SHARED LEAVE GROUPS (`/admin/leave-config/shared-groups`), a Leave Settings card of its own.
 *
 * ⚠️ A MOVE, NOT A CHANGE. Until this item the whole group catalogue — list, create, edit, delete — was a
 * Radix pop-up behind a "Shared leave groups" button on the Entitlements screen. The reporter found it hard
 * to find and cramped to work in, and asked for a card under Leave Settings that opens a page like the
 * other settings pages. Everything the pop-up did, this page does, through the SAME component
 * (`LeaveSharedGroupConfig`, now rendered inline rather than inside a Dialog) posting the SAME three server
 * actions with the SAME field names. No migration, no service change, no validation change: the
 * one-group-per-leave-type rule is still the database's (unique on (tenant, leave_type), migration 0342)
 * and is still reported by name from the action, never re-derived on screen.
 *
 * WHO CAN OPEN IT. A route on the existing `leaveConfig` screen key behind `requireAdmin` — the guard and
 * key of the Entitlements screen the editor came off — so exactly the people who could manage groups in
 * the pop-up can open this page, and no new permission exists.
 *
 * A SAVE MADE HERE LANDS HERE: the three actions return through the `SHARED_GROUPS` constant
 * (app/admin/_redirects.ts), repointed in the same commit that took the pop-up off Entitlements, so a save
 * and any `?error=` ("Marriage Leave already belongs to…", "a group with that name already exists") arrive
 * on the screen that holds the form they are about.
 *
 * WHAT A GROUP IS. Several LEAVE TYPES drawing on one pooled allowance. It holds no employees; employees
 * are covered through the leave types they are entitled to, so there is no employee assignment on this
 * page and none was moved.
 *
 * SERVER COMPONENT. The editor is the client island and receives serialisable props only — the group rows,
 * the active leave type options and three server actions (which serialise as references). No `t` and no
 * closure crosses the boundary (test/server-client-boundary.test.ts pins the class).
 */
export default async function LeaveConfigSharedGroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave.sharedGroup');
  const header = await leaveConfigPageHeader('sharedGroups');
  const { error } = await searchParams;

  const [types, sharedGroups] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listLeaveSharedGroups(s),
  ]);
  // The member tick list offers every ACTIVE leave type — the exact derivation the Entitlements screen
  // used for the pop-up (every leave type including archived, then the archived ones dropped), so the
  // options offered did not change with the move.
  const activeTypeOptions = types.filter((lt) => !lt.archivedAt).map((lt) => ({ id: lt.id, name: lt.name }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={header.title}
        description={header.description}
        actions={
          // A jump to the Create section below, not a second create path: the one form that posts the
          // create action is the one in that section (test/shared-leave-group-single-mechanism.test.ts).
          <a href="#new-shared-group" className={btnPrimary}>
            + {t('create')}
          </a>
        }
      />
      {/* One page under this row, so the tab row renders nothing but the "Back to Leave Settings" link.
          `current="sharedGroups"` because this IS that screen. */}
      <LeaveConfigMap current="sharedGroups" />
      <ErrorBanner message={error} />

      {/* Keyed on the group data so a save that changed a group remounts the editor with every inline form
          closed and every default re-read from the fresh rows; a refusal changes no row, so the form the
          admin was filling in stays open under the error banner above. */}
      <LeaveSharedGroupConfig
        key={JSON.stringify(sharedGroups)}
        groups={sharedGroups}
        leaveTypes={activeTypeOptions}
        actions={{
          create: createLeaveSharedGroupAction,
          update: updateLeaveSharedGroupAction,
          remove: deleteLeaveSharedGroupAction,
        }}
      />
    </div>
  );
}
