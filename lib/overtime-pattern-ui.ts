/** UI sample entry only. These facts are never an actual Attendance/Approval source. */
import type {OvertimeField,OvertimeInput} from './overtime-pattern-model';
export type OvertimeSampleSegment={id:string;sessionId:string;date:string;rawMinutes:string;dayType:string;endDayType:string;clockKnown:boolean;from:string;to:string;endDayOffset:0|1};
export type OvertimeSampleResource={id:string;resource:string;basis:'day'|'session';sessionId:string;quantity:string;unit:'minutes'|'money';evidence:'measured'|'policyCapacity'};
export type OvertimeSampleDraft={date:string;facts:Partial<Record<OvertimeField,string|null>>;sessionGranularity:OvertimeInput['sessionGranularity'];approvalStatus:OvertimeInput['approval']['status'];approvalMinutes:string;segments:OvertimeSampleSegment[];resources:OvertimeSampleResource[];currency:OvertimeInput['currency']};
