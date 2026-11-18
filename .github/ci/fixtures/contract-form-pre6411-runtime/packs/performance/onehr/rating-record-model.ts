import { sourceFigure, sourceRound } from './source-numeric';
import { z } from 'zod';
const value=z.number().finite().nullable();
const label=z.string().nullable();
export const ratingRecordSnapshotSchema=z.object({
 employeeId:z.string(),name:z.string(),businessGroup:label,company:z.string(),department:label,grade:label,title:label,
 mechanism:z.enum(['A','B']).nullable(),selfScore:value,selfBand:label,weightCovered:value,weightTotal:value,managerScore:value,managerBand:label,
 performance:label,performanceSource:label,leadershipScore:value,leadershipMax:value,submitted:z.number().int().min(0),valid:z.boolean(),
 competencyStatus:label,competencySelf:value,competencyReviewed:value,competencyMax:value,potentialScore:value,potentialMax:value,potential360Pct:value,potentialCompetencyPct:value,potentialBasis:z.enum(['none','combined','360_only']),computedPotential:label,potential:label,potentialSource:label,
 tiers:z.record(z.string(),z.object({performance:label,potential:label})),configuration:z.object({lowMaxPct:z.number(),midMaxPct:z.number(),weight360:z.number()}),
});
export type RatingRecordSnapshot=z.infer<typeof ratingRecordSnapshotSchema>;
export type RatingRecord={reviewId:string;snapshot:RatingRecordSnapshot;lastEvent:string;recordedAt:Date;frozenAt:Date|null};
// The source export's43 columns, in its original order. Justifications never enter this contract.
export const ratingRecordHeaders=[
 'Employee ID','Name','Business Group','Company','Department','Job Grade','Job Title',
 'PM mechanism','PM self score','PM self band','PM self weight covered %','PM manager-approved score','PM manager-approved band',
 'PM band after HOD','PM band after BU CEO','PM band after BG CEO','PM band after calibration group','PM super admin override','PM final band','PM final band decided by',
 '360 score','360 max','360 raters submitted','360 valid','Competency status','Competency self score','Competency reviewed score','Competency max',
 'Potential score (combined)','Potential score out of','Potential 360 share %','Potential competency share %','Potential basis','Potential band (computed)',
 'Potential band after HOD','Potential band after BU CEO','Potential band after BG CEO','Potential band after calibration group','Potential final band','Potential final band decided by',
 'Recorded at (UTC)','Last event','Frozen at (UTC)',
] as const;
const sources:Record<string,string>={manager:'Line manager',hod:'HOD',bu:'BU CEO',bg:'BG CEO',group:'Calibration group',final:'Super admin override'};
const figure=sourceFigure;
export function ratingRecordExportRow(record:RatingRecord):(string|number|null)[]{
 const s=record.snapshot,pmDigits=s.mechanism==='B'?1:2;
 return [s.employeeId,s.name,s.businessGroup,s.company,s.department,s.grade,s.title,s.mechanism,figure(s.selfScore,pmDigits),s.selfBand,
 s.weightTotal&&s.weightCovered!=null?sourceRound(100*s.weightCovered/s.weightTotal):null,figure(s.managerScore,pmDigits),s.managerBand,
 s.tiers.hod?.performance??null,s.tiers.bu?.performance??null,s.tiers.bg?.performance??null,s.tiers.group?.performance??null,s.tiers.final?.performance??null,s.performance,s.performanceSource?sources[s.performanceSource]??s.performanceSource:null,
 figure(s.leadershipScore),figure(s.leadershipMax),s.submitted,s.valid?'Yes':'No',s.competencyStatus,figure(s.competencySelf),figure(s.competencyReviewed),figure(s.competencyMax),figure(s.potentialScore),figure(s.potentialMax),figure(s.potential360Pct),figure(s.potentialCompetencyPct),s.potentialBasis,s.computedPotential,
 s.tiers.hod?.potential??null,s.tiers.bu?.potential??null,s.tiers.bg?.potential??null,s.tiers.group?.potential??null,s.potential,s.potentialSource==='manager'?'Computed (360 + competency)':s.potentialSource?sources[s.potentialSource]??s.potentialSource:null,
 record.recordedAt.toISOString(),record.lastEvent,record.frozenAt?.toISOString()??null];
}
/** Literal text stays literal in Excel, including names that resemble formulas. */
export function ratingRecordCell(v:string|number|null):string|number|null{return typeof v==='string'&&/^[=+\-@\t\r\n]/.test(v)?`'${v}`:v;}
