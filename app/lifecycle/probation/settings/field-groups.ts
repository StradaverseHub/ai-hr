import type {ProbationScopedField} from '@/lib/probation-settings-scope';

/**
 * The prototype draws Probation settings as cards (Who gets a case, Review plans, Timing, Extensions). Every scoped
 * field (decision 3) belongs to exactly one card; test/probation-config-parity.dom.test.tsx checks none is left out.
 */
export type SettingsCardId='who'|'plans'|'timing'|'kpis'|'extensions';
export const SETTINGS_CARDS:readonly {id:SettingsCardId;fields:readonly ProbationScopedField[]}[]=[
 {id:'who',fields:['eligibleGrades','gradeHEnabled']},
 {id:'plans',fields:['defaultMonths','plans']},
 {id:'timing',fields:['kpiGate','issueLeadDays','fallbackGroupId','postingApproverGroupId','nonWorkingDayRule','overrides']},
 {id:'kpis',fields:['kpiDueWorkingDays','kpiReminderWorkingDay','firstReminderDays','dailyReminderDays','lmWaitsForEmployee']},
 {id:'extensions',fields:['maxExtensions','lowBand']},
];
