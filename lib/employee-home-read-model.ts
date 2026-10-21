import type {DashboardRole} from './dashboard-cards';

/** Transport projection only. It is not an employment record, authority grant or business clock. */
export type EmployeeHomeIdentity={
 version:1;role:DashboardRole;
 employmentState:'none'|'choose'|'selected';selectedEmploymentId:string|null;companyEstablished:boolean;
 employments:{employmentId:string;employeeCode:string|null;company:string}[];
};
/** Presentation facts load with the greeting card, independently from employment selection. */
export type EmployeeHomeGreetingIdentity={version:1;employmentId:string;name:string|null;photoHref:string|null};
