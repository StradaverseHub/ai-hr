'use client';
import { useTranslations } from 'next-intl';
import { ApprovalMode } from '@/components/approval-mode';
import { Button, inputCls } from '@/components/ui';
import { ATTENDANCE_APPROVER_KINDS, attendanceLevelName, type AttendanceRoutingVersion, type AttendanceWorkflowStage } from '@/lib/attendance-workflow';
export const emptyAttendanceStage = (index = 0, routingVersion: AttendanceRoutingVersion = 1): AttendanceWorkflowStage => ({ name: routingVersion === 2 ? attendanceLevelName(index) : '', level: { kind: 'direct_manager', employmentId: null, alternates: [] } });
export function AttendanceStageEditor({ stages, onChange, routingVersion = 1 }: { routingVersion?: AttendanceRoutingVersion; stages: AttendanceWorkflowStage[]; onChange: (stages: AttendanceWorkflowStage[]) => void }) {
  const t = useTranslations('attendanceWorkflow'), shared = useTranslations('leaveApproval');
  const anyOne = stages.some(stage => stage.level.alternates.length > 0);
  const update = (next: AttendanceWorkflowStage[]) => onChange(routingVersion === 2 ? next.map((stage, index) => ({ ...stage, name: attendanceLevelName(index) })) : next);
  const patch = (index: number, stage: AttendanceWorkflowStage) => update(stages.map((old, i) => i === index ? stage : old));
  const alternate = (index: number) => patch(index, { ...stages[index], level: { ...stages[index].level, alternates: [{ kind: stages[index].level.kind === 'direct_manager' ? 'hr_admin' : 'direct_manager', employmentId: null }] } });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= stages.length) return;
    const next = [...stages];
    [next[from], next[to]] = [next[to], next[from]];
    update(next);
  };
  return <div className="space-y-4">
    <ApprovalMode anyOne={anyOne} onChange={value => value ? alternate(0) : update(stages.map(stage => ({ ...stage, level: { ...stage.level, alternates: [] } })))} labels={{ modeTitle: shared('modeTitle'), modeSequential: shared('modeSequential'), modeSequentialHint: shared('modeSequentialHint'), modeAnyOne: shared('modeAnyOne'), modeAnyOneHint: shared('modeAnyOneHint') }}/>
    <p className="text-sm text-muted-foreground">{t('orderedHelp')}</p>
    <ol className="space-y-4">{stages.map((stage, index) => <li key={index} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t('stageNumber', { number: index + 1 })}</h3><div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={index === 0} onClick={() => move(index, index - 1)}>{t('moveUp')}</Button>
        <Button type="button" variant="secondary" disabled={index === stages.length - 1} onClick={() => move(index, index + 1)}>{shared('moveDown')}</Button>
        <Button type="button" variant="secondary" disabled={stages.length === 1} onClick={() => update(stages.filter((_, i) => i !== index))}>{t('remove')}</Button>
      </div></div>
      {routingVersion === 1 && <label className="block text-sm">{t('stageName')}<input name={`stages.${index}.name`} required maxLength={100} className={inputCls} value={stage.name} onChange={event => patch(index, { ...stage, name: event.target.value })}/></label>}
      <label className="block text-sm">{t('approver')}<select name={`stages.${index}.kind`} className={inputCls} value={stage.level.kind} onChange={event => {
        const kind = event.target.value as typeof ATTENDANCE_APPROVER_KINDS[number];
        patch(index, { ...stage, level: { kind, employmentId: null, alternates: stage.level.alternates.length ? [{ kind: kind === 'direct_manager' ? 'hr_admin' : 'direct_manager', employmentId: null }] : [] } });
      }}>{ATTENDANCE_APPROVER_KINDS.map(kind => <option key={kind} value={kind}>{kind === 'direct_manager' ? (routingVersion === 2 ? (index === 0 ? t('hierarchyFirst') : t('hierarchyNext', { number: index + 1 })) : t('manager')) : t('hr')}</option>)}</select></label>
      {stage.level.alternates.length > 0 ? <div className="space-y-2 border-l-2 border-border pl-4"><p className="text-xs font-semibold uppercase text-muted-foreground">{t('or')}</p><p className="text-sm">{stage.level.alternates[0].kind === 'direct_manager' ? t('manager') : t('hr')}</p><input type="hidden" name={`stages.${index}.alternate`} value={stage.level.alternates[0].kind}/><Button type="button" variant="secondary" onClick={() => patch(index, { ...stage, level: { ...stage.level, alternates: [] } })}>{t('removeAlternative')}</Button></div> : anyOne && <Button type="button" variant="secondary" onClick={() => alternate(index)}>{shared('addAlternate')}</Button>}
    </li>)}</ol>
    <Button type="button" variant="secondary" disabled={stages.length >= 10} onClick={() => update([...stages, emptyAttendanceStage(stages.length, routingVersion)])}>{t('addStage')}</Button>
  </div>;
}
