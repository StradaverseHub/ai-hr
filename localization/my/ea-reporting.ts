/** Statutory reporting catalogue. Labels are the reporter-approved C.P.8A wording. */
export const MY_EA_REPORTING = [
 {code:'EA_B1A',section:'B',destination:'grossSalary',label:'B1 (a) Gross salary, wages or leave pay (including overtime pay)'},
 {code:'EA_B1B',section:'B',destination:'directorFee',label:'B1 (b) Fees (including director fees), commission or bonus'},
 {code:'EA_B1C',section:'B',destination:'allowances',label:'B1 (c) Gross tips, perquisites, awards / rewards or other allowances'},
 {code:'EA_B1D',section:'B',destination:'taxBorneByEmployer',label:'B1 (d) Income tax borne by the employer in respect of his employee'},
 {code:'EA_B1E',section:'B',destination:'esos',label:'B1 (e) Employee Share Option Scheme (ESOS) benefit'},
 {code:'EA_B1F',section:'B',destination:'gratuity',label:'B1 (f) Gratuity'},
 {code:'EA_B3',section:'B',destination:'benefitsInKind',label:'B3 - Benefits in kind'},
 {code:'EA_B4',section:'B',destination:'livingAccommodation',label:'B4 - Value of living accommodation provided'},
 {code:'EA_B5',section:'B',destination:'unapprovedFundRefund',label:'B5 - Refund from unapproved Provident / Pension Fund'},
 {code:'EA_B6',section:'B',destination:'compensation',label:'B6 - Compensation for loss of employment'},
 {code:'EA_C1',section:'C',destination:'pension',label:'C1 - Pension'},
 {code:'EA_C2',section:'C',destination:'annuity',label:'C2 - Annuities or other periodical payments'},
].map((entry, order) => ({...entry, order, active:true}));
