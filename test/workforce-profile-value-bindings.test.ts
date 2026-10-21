/** Source contract only; it is not evidence that the SQL functions or RLS have executed. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {workforceMaintenanceFields} from '../lib/workforce-maintenance-fields';
const migration=readFileSync(new URL('../db/migrations/0579_configurable_access.sql',import.meta.url),'utf8');
describe('physical profile/register authorization declaration',()=>{
 it('keeps Workforce field selection explicit and separate from self-service policy',()=>{
  const body=migration.split('CREATE FUNCTION app.access_workforce_command_fields(')[1].split('$$;')[0];
  for(const [kind,count]of [['person',31],['qualification',9],['emergency',6],['dependent',20]] as const){
   const list=body.match(new RegExp(`WHEN '${kind}' THEN ARRAY\\[([^\\]]+)\\]`))![1];
   const actual=[...list.matchAll(/'([^']+)'/g)].map(match=>match[1]).sort();
   const declared=workforceMaintenanceFields(kind);expect(actual).toEqual(declared.map(field=>field.key).sort());
   expect(actual).toHaveLength(count);for(const item of declared)expect(item.field).toBeDefined();
   for(const forbidden of ['isTestRecord','salary','bankAccount','photo','remarks'])expect(actual).not.toContain(forbidden);
  }
  expect(migration).toContain('AND b.field_name=ANY(app.access_workforce_command_fields(p_kind))');
 });
 it('guards the declared additional organisation labels and plain contract remark without borrowing independent grade/payroll columns',()=>{
  const body=migration.split('CREATE FUNCTION app.access_workforce_flat_info_columns()')[1].split('$$;')[0].split('AS $$')[1];
  const actual=[...body.matchAll(/'([a-z_]+)'/g)].map(match=>match[1]).sort();
  const expected=PERSONNEL_FIELDS.filter(field=>field.id.startsWith('employment.additional_organisation_labels.')||field.id==='employment.employment_dates_and_service.contractremark').map(field=>field.ownerField.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())).sort();
  expect(actual).toEqual(expected);expect(actual).toHaveLength(9);
  for(const field of ['grade_id','hired_on','last_working_date','payroll_policy_id'])expect(actual).not.toContain(field);
 });
 it('pins every physical ESS person/compliance/register binding to the canonical field registry',()=>{
  const body=migration.split('CREATE FUNCTION app.access_profile_value_bindings()')[1].split('; $$;')[0];
  const literal="(?:'((?:[^']|'')*)'|(NULL))";
  const row=new RegExp(String.raw`^ \(`+Array.from({length:5},()=>literal).join(',')+',(?<immediate>true|false),'+Array.from({length:3},()=>literal).join(',')+String.raw`\)`,'gm');
  const actual=[...body.matchAll(row)].map(m=>({id:m[1],owner:m[3],column:m[5],field:m[7],legacy:m[9]??null,immediate:m.groups!.immediate==='true',primary:m[12]??null,tab:m[14],section:m[16]}));
  const expected=PERSONNEL_FIELDS.filter(f=>f.ess.binding&&['person','compliance','dependent','qualification','emergency'].includes(f.ess.binding.owner)).map(f=>({
   id:f.id,owner:f.ess.binding!.owner,column:f.ess.binding!.field.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),field:f.ess.binding!.field,
   legacy:f.ess.binding!.legacyKey??null,immediate:f.ess.edit==='immediate',primary:f.ess.legacyPrimaryKey??null,tab:f.tab,section:f.section,
  }));
  expect(actual).toEqual(expected);expect(actual.length).toBeGreaterThan(50);
 });
 it('retains deferred transaction completion and private evidence without a runtime bypass flag',()=>{
  const valueScope=migration.slice(migration.indexOf('CREATE FUNCTION app.access_profile_value_bindings()'));
  for(const table of ['person','employee_dependent','employee_qualification','person_emergency_contact'])
   expect(valueScope).toContain(`AFTER INSERT OR UPDATE${table==='person'?'':' OR DELETE'} ON ${table}\nDEFERRABLE INITIALLY DEFERRED`);
  expect(valueScope).toContain('proof.xact_id=pg_current_xact_id()');expect(valueScope).toContain("proof.approved AND proof.audited AND r.status='approved'");
  expect(valueScope).toContain('app.access_profile_route_fingerprint(q.employment_id)');
  expect(valueScope).toContain('REVOKE ALL ON TABLE app.access_profile_value_actor,app.access_profile_value_approval,app.access_profile_register_application FROM PUBLIC,ai_hr_app');
  expect(valueScope).not.toContain('set_config(');expect(valueScope).not.toContain("current_setting('app.profile_route_maintenance'");
 });
});
