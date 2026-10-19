'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button, inputCls } from '@/components/ui';
import { attendanceLevelName } from '@/lib/attendance-workflow';
import { attendanceLevelProblemMessageKey, ATTENDANCE_V3_LIMITS, type AttendanceV3Level, type AttendanceLevelProblem } from '@/lib/attendance-workflow-v3';

/** V3 editor. Existing templates enter only through the explicit new-route conversion control. */
export const emptyAttendanceV3Level = (index: number): AttendanceV3Level => ({ name: attendanceLevelName(index), mode: 'sequential', source: { kind: 'direct_manager', depth: 1 }, hrAlternative: false });
export function AttendanceStageEditorV3({ id, stages, employees, onChange, problems = [] }: {
    id: string;
    stages: AttendanceV3Level[];
    employees: { id: string; name: string; employeeCode?: string | null }[];
    onChange: (stages: AttendanceV3Level[]) => void;
    problems?: readonly AttendanceLevelProblem[];
}) {
    const t = useTranslations('attendanceWorkflow'), v3 = useTranslations('attendanceWorkflow.v3');
    const summary = useRef<HTMLDivElement>(null);
    useEffect(() => { if (problems.length) summary.current?.focus(); }, [problems]);
    const update = (next: AttendanceV3Level[]) => onChange(next.map((level, index) => ({ ...level, name: attendanceLevelName(index) })));
    const patch = (index: number, next: AttendanceV3Level) => update(stages.map((old, i) => i === index ? next : old));
    const total = stages.reduce((count, level) => count + (level.source.kind === 'specific_employee' ? level.source.employmentIds.length : 1), 0);
    const moveLevel = (from: number, to: number) => {
        if (to < 0 || to >= stages.length) return;
        const next = [...stages]; [next[from], next[to]] = [next[to], next[from]]; update(next);
    };
    const describe = (problem: AttendanceLevelProblem) => v3(attendanceLevelProblemMessageKey(problem));
    return <div className="space-y-4">
        {problems.length > 0 && <div ref={summary} tabIndex={-1} role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive outline-offset-4">
            <p className="font-semibold">{v3('summary')}</p><ul className="mt-2 list-disc pl-5">{problems.map((problem, index) => <li key={index}>{problem.levelIndex == null ? describe(problem) : <a className="underline" href={`#${id}-level-${problem.levelIndex}`} onClick={event => { event.preventDefault(); document.getElementById(`${id}-level-${problem.levelIndex}`)?.focus(); }}>{t('stageNumber', { number: problem.levelIndex + 1 })}: {describe(problem)}</a>}</li>)}</ul>
        </div>}
        <p className="text-sm text-muted-foreground">{v3('levelHelp')}</p>
        <ol className="space-y-4">{stages.map((level, levelIndex) => {
            const levelProblems = problems.filter(problem => problem.levelIndex === levelIndex);
            const source = level.source, selected = source.kind === 'specific_employee' ? source.employmentIds : [];
            const personLabel = (employmentId: string) => { const employee = employees.find(row => row.id === employmentId); return employee ? [employee.employeeCode, employee.name].filter(Boolean).join(' · ') : t('unavailable', { value: employmentId }); };
            const movePerson = (from: number, to: number) => {
                if (source.kind !== 'specific_employee' || to < 0 || to >= selected.length) return;
                const employmentIds = [...selected]; [employmentIds[from], employmentIds[to]] = [employmentIds[to], employmentIds[from]];
                patch(levelIndex, { ...level, source: { ...source, employmentIds } });
            };
            return <li key={levelIndex} id={`${id}-level-${levelIndex}`} tabIndex={-1} aria-describedby={levelProblems.length ? `${id}-errors-${levelIndex}` : undefined} className="space-y-3 rounded-lg border border-border p-4 outline-offset-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t('stageNumber', { number: levelIndex + 1 })}</h3><div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" disabled={levelIndex === 0} onClick={() => moveLevel(levelIndex, levelIndex - 1)}>{t('moveUp')}</Button>
                    <Button type="button" variant="secondary" disabled={levelIndex === stages.length - 1} onClick={() => moveLevel(levelIndex, levelIndex + 1)}>{v3('moveDown')}</Button>
                    <Button type="button" variant="secondary" disabled={stages.length === 1} onClick={() => update(stages.filter((_, i) => i !== levelIndex))}>{t('remove')}</Button>
                </div></div>
                <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{v3('mode')}</legend>{(['sequential', 'any_one'] as const).map(mode => <label key={mode} className="flex items-start gap-2 text-sm">
                    <input type="radio" className="mt-1" name={`${id}-mode-${levelIndex}`} value={mode} checked={level.mode === mode} onChange={() => patch(levelIndex, { ...level, mode })}/>
                    <span><span className="font-medium">{v3(mode === 'sequential' ? 'sequential' : 'anyOne')}</span><span className="block text-xs text-muted-foreground">{v3(mode === 'sequential' ? 'sequentialHelp' : 'anyOneHelp')}</span></span>
                </label>)}</fieldset>
                <label className="block text-sm">{v3('source')}<select name={`${id}-source-${levelIndex}`} className={inputCls} value={source.kind} onChange={event => patch(levelIndex, { ...level, source: event.target.value === 'direct_manager' ? { kind: 'direct_manager', depth: 1 } : { kind: 'specific_employee', employmentIds: [] }, hrAlternative: false })}>
                    <option value="direct_manager">{v3('directSuperior')}</option><option value="specific_employee">{v3('selectedEmployees')}</option>
                </select></label>
                {source.kind === 'direct_manager' ? <>
                    <label className="block text-sm">{v3('depth')}<select name={`${id}-depth-${levelIndex}`} className={inputCls} value={source.depth} onChange={event => patch(levelIndex, { ...level, source: { ...source, depth: Number(event.target.value) } })}>{[1, 2, 3, 4, 5].map(depth => <option key={depth} value={depth}>{v3('depthOption', { number: depth })}</option>)}</select></label>
                    <p className="text-xs text-muted-foreground">{v3('depthHelp')}</p>
                    <label className="flex gap-2 text-sm"><input type="checkbox" checked={level.hrAlternative} onChange={event => patch(levelIndex, { ...level, hrAlternative: event.target.checked })}/>{v3('hrAlternative')}</label>
                </> : <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">{v3('selectedHelp')}</p>
                    {level.hrAlternative && <p role="alert" className="text-sm text-destructive">{v3('groupHrRefused')}</p>}
                    <ol className="space-y-2">{selected.map((employmentId, participantIndex) => <li key={`${employmentId}-${participantIndex}`} className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm">
                        <span className="min-w-0 flex-1 break-words">{participantIndex + 1}. {personLabel(employmentId)}</span><div className="flex flex-wrap gap-2">
                            <Button type="button" variant="secondary" disabled={participantIndex === 0} aria-label={v3('personUp', { name: personLabel(employmentId) })} onClick={() => movePerson(participantIndex, participantIndex - 1)}>{t('moveUp')}</Button>
                            <Button type="button" variant="secondary" disabled={participantIndex === selected.length - 1} aria-label={v3('personDown', { name: personLabel(employmentId) })} onClick={() => movePerson(participantIndex, participantIndex + 1)}>{v3('moveDown')}</Button>
                            <Button type="button" variant="secondary" aria-label={v3('removePerson', { name: personLabel(employmentId) })} onClick={() => patch(levelIndex, { ...level, source: { ...source, employmentIds: selected.filter((_, i) => i !== participantIndex) } })}>{t('remove')}</Button>
                        </div>
                    </li>)}</ol>
                    <label className="block text-sm">{v3('addPerson')}<select className={inputCls} value="" name={`${id}-add-${levelIndex}`} disabled={selected.length >= ATTENDANCE_V3_LIMITS.participantsPerLevel || total >= ATTENDANCE_V3_LIMITS.participantsPerWorkflow} onChange={event => { if (event.target.value) patch(levelIndex, { ...level, source: { ...source, employmentIds: [...selected, event.target.value] } }); }}>
                        <option value="">{v3('choosePerson')}</option>{employees.filter(employee => !selected.includes(employee.id)).map(employee => <option key={employee.id} value={employee.id}>{personLabel(employee.id)}</option>)}
                    </select></label>
                </div>}
                {levelProblems.length > 0 && <ul id={`${id}-errors-${levelIndex}`} className="space-y-1 text-sm text-destructive">{levelProblems.map((problem, index) => <li key={index}>{describe(problem)}</li>)}</ul>}
            </li>;
        })}</ol>
        <p className="text-xs text-muted-foreground">{v3('limits')}</p>
        <Button type="button" variant="secondary" disabled={stages.length >= ATTENDANCE_V3_LIMITS.levels || total >= ATTENDANCE_V3_LIMITS.participantsPerWorkflow} onClick={() => update([...stages, emptyAttendanceV3Level(stages.length)])}>{t('addStage')}</Button>
    </div>;
}
