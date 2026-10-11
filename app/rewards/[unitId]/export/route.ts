import { getSession } from '@/lib/session';
import { getRewardUnit } from '@/packs/rewards/service';

function cell(value: unknown): string {
  const text = String(value ?? '');
  const safe = typeof value === 'number' ? text : /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
export async function GET(request: Request, { params }: { params: Promise<{ unitId: string }> }) {
  const s = await getSession(), { unitId } = await params;
  const v = await getRewardUnit(s, unitId);
  const template = new URL(request.url).searchParams.get('template') === '1';
  if (!v.roles.includes('gr')) return new Response('Group Rewards access required.', { status: 403 });
  const keys = ['employmentId', 'employeeCode', 'name', 'talent', 'performance', 'confidentiality', 'seniorPlan', 'erCase', 'pipCase', 'erDecision', 'pipDecision', 'caseReason', 'branch', 'segment', 'reviewed'];
  const headers = template ? keys : ['employeeCode', 'name', 'grade', 'plan', 'basic', 'merit', 'promotion', 'special', 'newBasic', 'bonus', 'lumpSum'];
  const lines = v.rows.map(e => template ? [e.source.employmentId, e.source.employeeCode, e.source.name, e.facts.talent, e.facts.performance, e.facts.confidentiality, e.facts.seniorPlan, e.facts.erCase, e.facts.pipCase, e.facts.erDecision, e.facts.pipDecision, e.facts.caseReason, e.facts.branch, e.facts.segment, e.facts.reviewed] : [e.source.employeeCode, e.source.name, e.source.grade, e.plan, e.source.basicCents / 100, e.meritCents / 100, e.promotionCents / 100, e.specialCents / 100, e.newBasicCents / 100, e.bonusCents / 100, e.lumpCents / 100]);
  return new Response('\uFEFF' + [headers, ...lines].map(row => row.map(cell).join(',')).join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rewards-${template ? 'inputs' : 'review'}.csv"`, 'Cache-Control': 'private, no-store' } });
}
