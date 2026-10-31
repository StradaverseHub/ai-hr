import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import type { WorkspaceQuery } from '@/app/(app)/performance/workspace/workspace-screen';
import { workspaceTabRoute } from '@/app/(app)/performance/workspace/tab-route';

/** D-P1-32 PT-X2 — Approve KPIs. The workspace narrowed to the `pm.approve` tab; 404 when that tab is hidden. */
export default async function ApproveKpisPage({searchParams}:{searchParams:Promise<WorkspaceQuery>}) {
 await requireModule('performance');const {s}=await scopedSession();
 return workspaceTabRoute(s,'pm.approve',await searchParams);
}
