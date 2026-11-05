import { requireAdmin } from '@/lib/authz';
import { AgentBuildListAccessError, agentBuildList } from '@/core/agent-build-list';
import { parseWindow } from '@/core/process-assessment';

/** Same group-only read owner as the page (Administration › Build list). No user-supplied tenant, company, entries or
 * measurements. Moved from /control-tower/opportunities/backlog, which forwards here (AI Centre restructure, 4 Nov 2026). */
export async function GET(request: Request) {
  const session = await requireAdmin();
  const window = parseWindow(new URL(request.url).searchParams.get('days'));
  let packet;
  try { const {assessment: _assessment, ...result} = await agentBuildList(session, window); packet=result; }
  catch(error) {
    if(error instanceof AgentBuildListAccessError)return Response.json({error:'forbidden'},{status:403,headers:{'Cache-Control':'private, no-store'}});
    throw error;
  }
  return Response.json(packet, {headers:{
    'Cache-Control':'private, no-store',
    'Content-Disposition':`attachment; filename="ai-build-list-${window}d.json"`,
  }});
}
