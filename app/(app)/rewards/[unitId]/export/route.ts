import { getSession } from '@/lib/session';
import { getRewardUnit } from '@/packs/rewards/service';
import {isSeniorPlanMember} from '@/packs/rewards/model';
import { payWindowReasons } from '@/packs/rewards/engine';

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
  // 8ad87ae8: everyone with a basic-salary change in the review's exclusion window, and Group Rewards' decision.
  if (new URL(request.url).searchParams.get('excluded') === '1') {
    const kept = v.unit.policy.payWindowKeep ?? {};
    const rows = v.rows.filter(e => e.payChange).map(e => [e.source.employeeCode, e.source.name, e.plan, e.payChange!.kind ?? '', e.payChange!.on, e.source.basicCents / 100, e.bonusBasicCents / 100,
      e.payWindowKept ? 'kept eligible' : payWindowReasons.includes(e.incrementReason) ? 'excluded from salary increase' : e.incrementReason, kept[e.source.employmentId] ?? '']);
    const head = ['employeeCode', 'name', 'plan', 'changeType', 'effectiveOn', 'currentBasic', 'adjustedBasic', 'salaryIncrease', 'keepReason'];
    return new Response('\uFEFF' + [head, ...rows].map(row => row.map(cell).join(',')).join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rewards-pay-change-exclusions.csv"', 'Cache-Control': 'private, no-store' } });
  }
  const keys = ['employmentId', 'employeeCode', 'name', 'talent', 'performance', 'confidentiality', 'seniorPlan', 'erCase', 'pipCase', 'erDecision', 'pipDecision', 'caseReason', 'branch', 'segment', 'reviewed'];
  const headers = template ? keys : ['employeeCode', 'name', 'grade', 'plan', 'basic', 'merit', 'promotion', 'special', 'newBasic', 'bonus', 'lumpSum', 'awardPlan'];
  const lines = v.rows.map(e => template ? [e.source.employmentId, e.source.employeeCode, e.source.name, e.facts.talent, e.facts.performance, e.facts.confidentiality, e.facts.seniorPlan, e.facts.erCase, e.facts.pipCase, e.facts.erDecision, e.facts.pipDecision, e.facts.caseReason, e.facts.branch, e.facts.segment, e.facts.reviewed] : [e.source.employeeCode, e.source.name, e.source.grade, e.plan, e.source.basicCents / 100, e.meritCents / 100, e.promotionCents / 100, e.specialCents / 100, e.newBasicCents / 100, e.bonusCents / 100, e.lumpCents / 100,isSeniorPlanMember(v.unit.policy,e.facts,e.source.grade)?'Senior plan':'Standard']);
  return new Response('\uFEFF' + [headers, ...lines].map(row => row.map(cell).join(',')).join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rewards-${template ? 'inputs' : 'review'}.csv"`, 'Cache-Control': 'private, no-store' } });
}
