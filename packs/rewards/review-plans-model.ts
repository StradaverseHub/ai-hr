/** Review Plans contracts. Client-safe configuration metadata; never individual pay. */
import {z} from 'zod';
import type {RewardPlanLibraryChoice} from './setup-query-owner';
export const rewardPlanTypes=['standard','uploaded','no_awards'] as const;
export type RewardReviewPlanType=typeof rewardPlanTypes[number];
export const rewardYearSettingsSchema=z.object({effectiveFrom:z.iso.date(),joinedBefore:z.iso.date(),confirmedBy:z.iso.date(),activeAsOf:z.iso.date(),blockedFrom:z.iso.date(),blockedTo:z.iso.date(),snapshotDate:z.iso.date()}).strict().refine(v=>v.blockedFrom<=v.blockedTo,'Invalid exclusion window');
export type RewardYearSettings=z.infer<typeof rewardYearSettingsSchema>;
export const rewardYearInputSchema=z.object({year:z.number().int().min(2000).max(2200),settings:rewardYearSettingsSchema}).strict();
export type RewardYearInput=z.infer<typeof rewardYearInputSchema>;
export type RewardPlanSuggestion={versionId:string|null;source:'previous-year'|'business-unit'|'group-default'|'multiple-matches'|'none';reviewed:boolean};
export type RewardReviewPlanRow={companyId:string;company:string;businessUnitId:string|null;businessUnit:string|null;revision:number;planVersionId:string|null;planType:RewardReviewPlanType;reason:string;salaryVersionId:string|null;bonusVersionId:string|null;salarySuggestion:RewardPlanSuggestion;bonusSuggestion:RewardPlanSuggestion;headcount:number;patEntered:boolean;status:'draft'|'ready'|'reviews-created';canEdit:boolean;reviewUnitId:string|null;branchAcknowledged:boolean};
export type RewardReviewPlanFilters={businessUnitId?:string;planType?:RewardReviewPlanType;missingSalary?:boolean;missingBonus?:boolean;unreviewed?:boolean};
export type RewardReviewPlansQuery={year:number;filters?:RewardReviewPlanFilters;page?:number};
export type RewardReviewPlans={years:number[];businessUnits:{id:string;name:string}[];excludedCompanies:{id:string;name:string;reason:string}[];yearSettings:RewardYearSettings|null;suggestedYearSettings:RewardYearSettings;rows:RewardReviewPlanRow[];coverage:{total:number;ready:number;missingSalary:number;missingBonus:number;missingPat:number;unreviewed:number;reviewsCreated:number};libraries:RewardPlanLibraryChoice[];canCreateYear:boolean;canEdit:boolean;canCreateReviews:boolean;page:number;hasMore:boolean};
export const rewardPlanGridEditSchema=z.object({companyId:z.uuid(),expectedRevision:z.number().int().nonnegative(),planType:z.enum(rewardPlanTypes),reason:z.string().trim().max(4000).default(''),salaryVersionId:z.uuid().nullable(),bonusVersionId:z.uuid().nullable(),salaryReviewed:z.boolean(),bonusReviewed:z.boolean(),branchAcknowledged:z.boolean().default(false)}).strict().refine(v=>v.planType!=='no_awards'||v.reason.length>=10,'Give an exclusion reason of at least 10 characters');
export type RewardPlanGridEdit=z.infer<typeof rewardPlanGridEditSchema>;
export const rewardPlanGridInputSchema=z.object({year:z.number().int().min(2000).max(2200),edits:z.array(rewardPlanGridEditSchema).min(1).max(500)}).strict().refine(v=>new Set(v.edits.map(e=>e.companyId)).size===v.edits.length,'A company may be edited only once');
export type RewardPlanGridInput=z.infer<typeof rewardPlanGridInputSchema>;
/** Calendar-year shift clamps leap day rather than silently rolling into March. */
export function shiftRewardYearDate(date:string,years:number){const [y,m,d]=date.split('-').map(Number),target=y+years,last=new Date(Date.UTC(target,m,0)).getUTCDate();return`${target}-${String(m).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`;}
export function shiftRewardYearSettings(settings:RewardYearSettings,years:number):RewardYearSettings{return rewardYearSettingsSchema.parse(Object.fromEntries(Object.entries(settings).map(([key,date])=>[key,shiftRewardYearDate(date,years)])));}
export function rewardPlanReady(row:Pick<RewardReviewPlanRow,'planType'|'salaryVersionId'|'bonusVersionId'|'salarySuggestion'|'bonusSuggestion'|'patEntered'|'businessUnitId'>){return row.planType!=='no_awards'&&!!row.businessUnitId&&!!row.salaryVersionId&&!!row.bonusVersionId&&row.salarySuggestion.reviewed&&row.bonusSuggestion.reviewed&&row.patEntered;}
