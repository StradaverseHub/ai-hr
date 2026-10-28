import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { PerformanceWorkspaceScreen, type WorkspaceQuery } from './workspace-screen';

/** The whole review workspace. Every old `/performance/workspace?…` URL keeps landing here unchanged (D-P1-32 D8). */
export default async function PerformanceWorkspacePage({searchParams}:{searchParams:Promise<WorkspaceQuery>}) {
 await requireModule('performance');const {s}=await scopedSession(),query=await searchParams;
 return <PerformanceWorkspaceScreen s={s} query={query}/>;
}
