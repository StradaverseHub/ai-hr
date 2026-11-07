/** AI Centre issue 13b — governed pay averages, declared in the semantic model (ADR-0169 §2.2 "metrics": named measures
 * and dimensions with small-group suppression, never free-form queries; owner decision 3 November 2026, "Yes, averages
 * only").
 *
 * One read for callers with payroll access, over the payroll pack's aggregate owner (packs/payroll/pay-averages.ts
 * payAverages). It returns one exactly labelled measure (basic pay paid in each company's latest closed regular run),
 * by company and optionally by department: headcount, average and median per group, never a person, an id or one
 * person's figure. Small groups, and groups whose publication would let a small group be derived, are suppressed by
 * the owner before anything is returned.
 *
 * Every headcount and figure is `bands`, although the caller may read every payslip behind it (ADR-0170 §2 principle 4:
 * what leaves to the provider is never an exact figure); the person sees the exact figures after restoration. Company
 * and department names are configuration the caller administers: `minimum`, kept for this administrator audience. Pure
 * declarations; nothing here reads or grants. */
import {provenanceField} from './entities-explain';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const PAY_AGGREGATE_MEASURES=['basic_pay_paid'] as const;
export const PAY_AGGREGATE_BREAKDOWNS=['company','department'] as const;
export const PAY_AGGREGATE_STATUSES=['published','suppressed','no_closed_run','not_combined'] as const;
export const PAY_AGGREGATE_REASONS=['fewer_than_minimum','values_identical','complement_too_small','protects_another_group','company_suppressed','mixed_currencies'] as const;

/** The figures of one group; absent when the group is suppressed. */
const figures=():SemanticField[]=>[
 f('status','enum','full','published; suppressed (no figure is shown); no_closed_run (no closed regular payroll run with payslips); not_combined (companies pay in different currencies).',{values:PAY_AGGREGATE_STATUSES}),
 f('withheldBecause','enum','full','Why the group is not shown: fewer than five people, every member paid the same, a complement of one to four people, protecting another withheld group, its company withheld, or mixed currencies.',{values:PAY_AGGREGATE_REASONS}),
 f('headcount','integer','bands','People in the group.'),
 f('average','number','bands','Average of the measure over the group, to the cent.'),
 f('median','number','bands','Median of the measure over the group, rounded to the nearest 10 currency units.'),
];
const currency=f('currency','label','full','The company\'s pay currency (ISO 4217).');

/** AI v2 W7: governed workforce metrics (core/workforce-metrics.ts workforceMetrics). Headcount, joiners, leavers,
 * turnover, overtime hours and annual leave days are `bands`; company and department names are `minimum`, kept as
 * configuration the caller administers or sees on My Team. Never a person, an id or one person's figure. */
export const WORKFORCE_METRIC_NAMES=['headcount','turnover','overtime_trend','leave_liability'] as const;
export const WORKFORCE_METRIC_PERIODS=['this_month','last_month','this_quarter','last_quarter','this_year','last_year'] as const;
export const WORKFORCE_METRIC_SCOPES=['administered_companies','team'] as const;
export const WORKFORCE_METRIC_STATUSES=['published','suppressed','no_people'] as const;
export const WORKFORCE_METRIC_REASONS=['fewer_than_minimum','values_identical','complement_too_small','protects_another_group','company_suppressed','team_suppressed'] as const;
const workforceStatus=()=>[
 f('status','enum','full','published; suppressed (no figure is shown); no_people (nobody in the group).',{values:WORKFORCE_METRIC_STATUSES}),
 f('withheldBecause','enum','full','Why the group is not shown: fewer than five people, every member with the same figure, a complement of one to four people, protecting another withheld group, or its company or the team withheld.',{values:WORKFORCE_METRIC_REASONS}),
];
const workforceFigures=():SemanticField[]=>[...workforceStatus(),
 f('headcount','integer','bands','People employed on the date; for a period, on its last day.'),
 f('joiners','integer','bands','People who joined within the period.'),
 f('leavers','integer','bands','People who left within the period.'),
 f('headcountStart','integer','bands','Headcount on the first day of the period.'),
 f('headcountEnd','integer','bands','Headcount on the last day of the period.'),
 f('averageHeadcount','number','bands','Average of the first-day and last-day headcount.'),
 f('turnoverRate','number','bands','Leavers divided by the average headcount, as a percentage to one decimal place; null when nobody was employed on either day.'),
 f('people','integer','bands','People whose annual leave balance is counted.'),
 f('totalDays','number','bands','Outstanding annual leave in days, summed over the group.'),
 f('averageDays','number','bands','Outstanding annual leave in days per person.'),
 f('months','list','full','Overtime hours per calendar month, oldest first.',{of:[f('month','period','full','The calendar month.'),...workforceStatus(),
  f('hours','number','bands','Overtime hours recorded in the month, summed over the group, to one decimal place.'),
  f('complete','boolean','full','False when some attendance days of the month have no calculated overtime yet; they count as none.')]}),
];
const workforceDepartments=(meaning:string)=>f('departments','list','minimum',meaning,{of:[
 f('department','label','minimum','The department\'s name; null for people with no single department on the date.'),...workforceFigures()]});

export const METRIC_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'pay_aggregate',label:'Pay averages',
  meaning:'Headcount, average and median basic pay from each company\'s latest closed regular payroll run, for the companies whose payroll the caller administers, by company and optionally by department. Groups only, never a person; small groups are withheld.',
  module:'payroll',sensitivity:'pay',audience:'admin',rls:'administered_scope',owners:['packs/payroll/pay-averages.ts#payAverages'],
  ruleVersion:null,relations:[],page:'/payroll/reconciliation',
  fields:[f('measure','enum','full','Which measure the figures are of.',{values:PAY_AGGREGATE_MEASURES}),
   f('measureLabel','label','full','Exactly what the measure counts and leaves out.'),
   f('breakdown','enum','full','By company, or by company and department.',{values:PAY_AGGREGATE_BREAKDOWNS}),
   f('overall','object','minimum','Every company the caller administers, combined; shown only when they share one currency.',{of:[currency,...figures()]}),
   f('companies','list','minimum','One row per company the caller administers.',{of:[f('company','label','minimum','The company\'s name.'),currency,
    f('payPeriod','period','full','Pay period of the run the figures come from.'),...figures(),
    f('departments','list','minimum','Departments of the company, when the breakdown is by department; people with no single current department last.',{of:[
     f('department','label','minimum','The department\'s name; null for people with no single current department.'),...figures()]})]}),
   provenanceField]},
 {id:'workforce_metric',label:'Workforce metrics',
  meaning:'Headcount with joiners and leavers, turnover, the overtime-hours trend and outstanding annual leave in days, counted by the service for the companies an HR administrator administers, or for a manager\'s own team (headcount as of today, overtime and leave days only). Groups only, never a person; small groups are withheld.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',owners:['core/workforce-metrics.ts#workforceMetrics'],
  ruleVersion:null,relations:[],page:'/analytics',
  fields:[f('metric','enum','full','Which metric the figures are of.',{values:WORKFORCE_METRIC_NAMES}),
   f('metricLabel','label','full','Exactly what the metric counts and leaves out.'),
   f('scope','enum','full','administered_companies (an HR administrator\'s companies) or team (a manager\'s own team).',{values:WORKFORCE_METRIC_SCOPES}),
   f('breakdown','enum','full','By company, or by company and department.',{values:PAY_AGGREGATE_BREAKDOWNS}),
   f('asOf','date','full','The date of a headcount or leave balance.'),
   f('period','object','full','The period of joiners, leavers or turnover.',{of:[f('from','date','full','First day.'),f('to','date','full','Last day.')]}),
   f('overall','object','minimum','Every company in scope combined, or the whole team.',{of:workforceFigures()}),
   f('companies','list','minimum','One row per company the HR administrator administers; empty for a team.',{of:[f('company','label','minimum','The company\'s name.'),...workforceFigures(),
    workforceDepartments('Departments of the company, when the breakdown is by department; people with no single department last.')]}),
   workforceDepartments('The team\'s departments, when a manager asks by department; people with no single department last.'),
   provenanceField]},
] satisfies SemanticEntity[]);

export const METRIC_READS:readonly SemanticRead[]=freeze([
 {name:'pay_aggregates',entity:'pay_aggregate',
  purpose:'Payroll access only: headcount, average and median basic pay from each company\'s latest closed payroll run, by company or by department. Group figures only, never one person\'s pay: groups under five people, and groups that would reveal one, are withheld. Use it for average or typical pay across a company or department.',
  input:[{name:'breakdown',identifier:false,optional:true,schema:{type:'string',enum:[...PAY_AGGREGATE_BREAKDOWNS],description:'company (the default) or department.'}}]},
 {name:'workforce_metrics',entity:'workforce_metric',
  purpose:'HR administrators, for the companies they administer, and managers, for their own team: headcount (with joiners and leavers over a period), turnover over a period, overtime hours per month for the last six full months, and outstanding annual leave in days. Counted by the service; group figures only, never one person: groups under five people, and groups that would reveal one, are withheld. A manager gets headcount as of today, overtime and leave days for their own team, and no turnover. Use it for headcount, joiners, leavers, turnover, overtime trend or leave liability questions; pass a named period instead of working out dates.',
  input:[{name:'metric',identifier:false,schema:{type:'string',enum:[...WORKFORCE_METRIC_NAMES],description:'headcount, turnover, overtime_trend or leave_liability.'}},
   {name:'breakdown',identifier:false,optional:true,schema:{type:'string',enum:[...PAY_AGGREGATE_BREAKDOWNS],description:'company (the default) or department.'}},
   {name:'period',identifier:false,optional:true,schema:{type:'string',enum:[...WORKFORCE_METRIC_PERIODS],description:'A named period the service resolves from today, for headcount (joiners and leavers) and turnover. Required for turnover unless from and to are given.'}},
   {name:'from',identifier:false,optional:true,schema:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'First day of a period the person gave as exact dates, YYYY-MM-DD, with to.'}},
   {name:'to',identifier:false,optional:true,schema:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'Last day of that period, YYYY-MM-DD, not after today.'}},
   {name:'as_of',identifier:false,optional:true,schema:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'The date of a headcount or leave balance, YYYY-MM-DD; today when left out.'}}]},
] satisfies SemanticRead[]);
