import type {DashboardRole} from './dashboard-cards';

/** Transport projection only. It is not an employment record, authority grant or business clock. */
export type EmployeeHomeIdentity={
 version:1;name:string|null;photoHref:string|null;role:DashboardRole;
 employmentState:'none'|'choose'|'selected';selectedEmploymentId:string|null;companyEstablished:boolean;
 employments:{employmentId:string;employeeCode:string|null;company:string}[];
};
