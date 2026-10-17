/** Release admission, independent of installed daemon readiness. Missing/nonexact values stay off.
 * Server consumers read at admission time; never send this environment input to the browser.
 */
export function employeeMasterScheduledEmailEnabled(env:Readonly<Record<string,string|undefined>>=process.env):boolean{
 return env.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED==='true';
}
