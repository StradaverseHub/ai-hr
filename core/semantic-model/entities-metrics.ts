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
export const PAY_AGGREGATE_REASONS=['fewer_than_minimum','complement_too_small','protects_another_group','company_suppressed','mixed_currencies'] as const;

/** The figures of one group; absent when the group is suppressed. */
const figures=():SemanticField[]=>[
 f('status','enum','full','published; suppressed (no figure is shown); no_closed_run (no closed regular payroll run with payslips); not_combined (companies pay in different currencies).',{values:PAY_AGGREGATE_STATUSES}),
 f('reason','enum','full','Why the group is not shown: fewer than five people, a complement of one to four people, protecting another withheld group, its company withheld, or mixed currencies.',{values:PAY_AGGREGATE_REASONS}),
 f('headcount','integer','bands','People in the group.'),
 f('average','number','bands','Average of the measure over the group, to the cent.'),
 f('median','number','bands','Median of the measure over the group, rounded to the nearest 10 currency units.'),
];
const currency=f('currency','label','full','The company\'s pay currency (ISO 4217).');

export const METRIC_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'pay_aggregate',label:'Pay averages',
  meaning:'Headcount, average and median basic pay from each company\'s latest closed regular payroll run, for the companies whose payroll the caller administers, by company and optionally by department. Groups only, never a person; small groups are withheld.',
  module:'payroll',sensitivity:'pay',audience:'admin',rls:'administered_scope',owners:['packs/payroll/pay-averages.ts#payAverages'],
  ruleVersion:null,relations:[],page:'/payroll/reports',
  fields:[f('measure','enum','full','Which measure the figures are of.',{values:PAY_AGGREGATE_MEASURES}),
   f('measureLabel','label','full','Exactly what the measure counts and leaves out.'),
   f('breakdown','enum','full','By company, or by company and department.',{values:PAY_AGGREGATE_BREAKDOWNS}),
   f('overall','object','minimum','Every company the caller administers, combined; shown only when they share one currency.',{of:[currency,...figures()]}),
   f('companies','list','minimum','One row per company the caller administers.',{of:[f('company','label','minimum','The company\'s name.'),currency,
    f('payPeriod','period','full','Pay period of the run the figures come from.'),...figures(),
    f('departments','list','minimum','Departments of the company, when the breakdown is by department; people with no single current department last.',{of:[
     f('department','label','minimum','The department\'s name; null for people with no single current department.'),...figures()]})]}),
   provenanceField]},
] satisfies SemanticEntity[]);

export const METRIC_READS:readonly SemanticRead[]=freeze([
 {name:'pay_aggregates',entity:'pay_aggregate',
  purpose:'Payroll access only: headcount, average and median basic pay from each company\'s latest closed payroll run, by company or by department. Group figures only, never one person\'s pay: groups under five people, and groups that would reveal one, are withheld. Use it for average or typical pay across a company or department.',
  input:[{name:'breakdown',identifier:false,optional:true,schema:{type:'string',enum:[...PAY_AGGREGATE_BREAKDOWNS],description:'company (the default) or department.'}}]},
] satisfies SemanticRead[]);
