import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {personnelControl,personnelInput,personnelFormChoices,personnelFormIssue,personnelFormName,personnelFormRequired,personnelFormMetadataIssue,personnelFormWidget,personnelWorkflowControl,personnelWorkflowInput,personnelWorkflowCarry,personnelDisplay} from '../lib/personnel-form-contract';
import {personnelFieldChoices,personnelFieldLabel} from '../lib/personnel-import-contract';
import {auditPersonnelFormSource} from './helpers/personnel-form-source';
const birth='profile.personal_details.dateofbirth';
const initial='employment.employment_dates_and_service.confirmationdate';
const final='employment.employment_dates_and_service.finalconfirmationdate';
describe('Personnel shared form contract',()=>{
  it('binds dated calendar workflow fields without adding generic report/import or self-service writers',()=>{
    const prefix='attendance.dated_holiday_calendar.';
    for(const suffix of ['calendar','startdate','enddate']){
      const field=PERSONNEL_FIELDS.find(row=>row.id===prefix+suffix)!;
      expect(field).toBeDefined();expect(field.owner).toBe('employmentHolidayCalendar');
      expect(field.report.enabled).toBe(false);expect(field.import.writer).toBeUndefined();
      expect(field.import.column).toBeUndefined();expect(field.ess.binding).toBeUndefined();
      expect(field.form?.workflowReason).toContain('Dated holiday calendar assignment owner');
    }
    expect(personnelControl(prefix+'calendar')).toMatchObject({name:'calendar',required:false});
    expect(personnelInput(prefix+'startdate','edit',{employmentStartDate:'2024-02-29'}))
      .toMatchObject({name:'startDate',type:'date',required:true,min:'2024-02-29'});
    expect(personnelInput(prefix+'enddate','edit',{calendarAssignmentStartDate:'2024-03-01'}))
      .toMatchObject({name:'endDate',type:'date',required:false,min:'2024-03-01'});
    expect(()=>personnelInput(prefix+'startdate')).toThrow(/date minimum context/);
    expect(()=>personnelInput(prefix+'enddate','edit',{calendarAssignmentStartDate:'2025-02-29'})).toThrow(/date minimum context/);
    const changed=structuredClone(PERSONNEL_FIELDS.find(row=>row.id===prefix+'startdate')!);
    changed.form!.widget='date';changed.type='text';
    expect(personnelFormMetadataIssue(changed)).toContain('canonical type');
    delete changed.form!.widget; // Isolate the minOwner rule from the earlier explicit-widget guard.
    expect(personnelFormMetadataIssue(changed)).toContain('date minimum');
    changed.type='date';changed.form!.min=0;expect(personnelFormMetadataIssue(changed)).toContain('date minimum');
    // Other numeric/date widgets retain their existing metadata and never borrow this context.
    expect(personnelInput(birth,'edit',{employmentStartDate:'2024-02-29'})).not.toHaveProperty('min');
  });
  it('retains the classification safety fact without a Personnel form or generic writer',()=>{
    const id='employment.data_classification.istestrecord',field=PERSONNEL_FIELDS.find(f=>f.id===id)!;
    expect(field).toMatchObject({type:'boolean',owner:'employment',ownerField:'isTestRecord'});
    expect(field.form).toBeUndefined();
    expect(()=>personnelControl(id,'edit')).toThrow(/form binding is missing/);
    expect(()=>personnelInput(id,'edit')).toThrow(/form binding is missing/);
    expect(field.import.column).toBeUndefined();expect(field.import.writer).toBeUndefined();expect(field.ess.binding).toBeUndefined();
  });
  it('resolves the mounted read-only employment values without exposing a writable join-date field',()=>{
    for(const id of ['employment.organisation_assignment.gradename','employment.organisation_assignment.employmenttype','employment.employment_dates_and_service.hiredon','employment.employment_dates_and_service.joindate'])expect(personnelDisplay(id)).toEqual({'data-personnel-field':id});
    const join='employment.employment_dates_and_service.joindate';
    expect(personnelControl(join)).not.toHaveProperty('name');
    expect(()=>personnelInput(join)).toThrow(/specialized/);
    expect(PERSONNEL_FIELDS.find(field=>field.id===join)).toMatchObject({ownerField:'joinDate',form:{widget:'display'},history:'current'});
  });

  it('keeps draft JSON controls unnamed while form controls post the declared canonical name',()=>{
    expect(personnelInput(birth)).toMatchObject({name:'dateOfBirth',type:'date',required:false});
    expect(personnelInput(birth,'draft')).not.toHaveProperty('name');
    expect(personnelFormName(initial)).toBe('confirmationDate');
    expect(()=>personnelFormName(initial,'finalConfirmationDate')).toThrow(/binding/);
    expect(()=>personnelInput(final)).toThrow(/specialized/);
  });
  it('separates editable initial confirmation from the derived final report fact without retiring an ID',()=>{
    expect(PERSONNEL_FIELDS.find(field=>field.id===initial)).toMatchObject({ownerField:'confirmationDate',import:{column:'confirmation_date',writerField:'confirmationDate'}});
    expect(PERSONNEL_FIELDS.find(field=>field.id===final)).toMatchObject({ownerField:'finalConfirmationDate',form:{widget:'display'}});
    expect(PERSONNEL_FIELDS.find(field=>field.id===final)?.import.column).toBeUndefined();
  });
  it('uses shared date, required and unit decisions',()=>{
    expect(personnelFormIssue(birth,'2025-02-29')).toBe('date');
    expect(personnelFormIssue(birth,'2024-02-29')).toBeNull();
    expect(personnelFormIssue('profile.personal_details.fullname','','create')).toBe('required');
    expect(personnelFormIssue('profile.personal_details.fullname','','draft')).toBe('required');
    expect(personnelControl('profile.personal_details.fullname','draft').required).toBe(false);
    expect(personnelFormChoices('employment.employment_dates_and_service.probationunit').map(option=>option.value)).toEqual(['month','week','day']);
  });
  it('uses domain-owned conditional requirements without a second required-create boolean',()=>{
    const remarks='payroll.basic_salary_and_salary_history.remarks';
    expect(personnelFormRequired(remarks,'draft',{noBasicSalary:true})).toBe(true);
    expect(personnelFormRequired(remarks,'draft',{noBasicSalary:false})).toBe(false);
    expect(personnelControl(remarks,'draft',{noBasicSalary:true}).required).toBe(false);
    const company='employment.organisation_assignment.companyname';
    expect(personnelFormRequired(company,'create',{selectCompany:true})).toBe(true);
    expect(PERSONNEL_FIELDS.find(field=>field.id===company)?.import.requiredCreate).toBe(false);
  });
  it('distinguishes selection IDs from code/name projections and binds the real draft end-date payload',()=>{
    expect(personnelFormName('employment.direct_superior_and_history.superioremploymentid')).toBe('superiorEmploymentId');
    expect(personnelFormName('employment.approval_delegations.delegateemploymentid')).toBe('delegateEmploymentId');
    expect(personnelFormName('attendance.work_location_and_shift_arrangement.locationid')).toBe('locationId');
    for(const id of ['employment.direct_superior_and_history.superioremploymentid','employment.approval_delegations.delegateemploymentid','attendance.work_location_and_shift_arrangement.locationid'])expect(PERSONNEL_FIELDS.find(field=>field.id===id)?.report.enabled).toBe(false);
    expect(PERSONNEL_FIELDS.find(field=>field.id==='employment.draft_only_employment_fields.internshipenddate')).toMatchObject({ownerField:'provisionalEndOn',form:{draftPath:'employment.provisionalEndOn'}});
  });
  it('declares every relief grid count with a canonical composed label and exact owner cell',()=>{
    const cells=PERSONNEL_FIELDS.filter(field=>field.childReliefCell);
    expect(cells).toHaveLength(10);
    expect(new Set(cells.map(field=>field.form!.name)).size).toBe(10);
    for(const field of cells){
      expect(field.ownerField).toBe('childReliefTable');
      expect(field.report.enabled).toBe(true);
      // 0db97f14 — each cell is a Bank & Statutory import column, written by the merged statutory writer.
      expect(field.import).toMatchObject({column:'child_relief_'+field.childReliefCell!.category+'_'+field.childReliefCell!.share,writer:'statutory',section:'bank_statutory'});
      expect(field.form!.name).toBe('childRelief_'+field.childReliefCell!.category+'_'+field.childReliefCell!.share);
      for(const locale of ['en','ms','ta','th','vi','zh']){
        const messages=JSON.parse(readFileSync(new URL('../messages/'+locale+'.json',import.meta.url),'utf8'));
        const label=personnelFieldLabel(field,(key)=>key.split('.').reduce((value,part)=>value[part],messages));
        expect(label.split(' — ')).toHaveLength(2);expect(label).not.toContain('undefined');
      }
    }
  });
  it('separates offered EPF election categories from the persisted lawful enum',()=>{
    const election='bank_statutory.epf_contribution.epfuimode';
    expect(personnelFormChoices(election).map(choice=>choice.value)).toEqual(['auto','manual_percentage','voluntary_percentage','semi_auto','manual_employee_amount','manual_employer_amount','manual_both_amount','none']);
    expect(personnelFormName(election)).toBe('epfMode');
    expect(()=>personnelInput('bank_statutory.epf_contribution.epfmode')).toThrow(/specialized/);
    expect(personnelInput('bank_statutory.epf_contribution.epfemployeeamount','draft').required).toBe(false);
    expect(personnelInput('bank_statutory.epf_contribution.epfemployeeamount','edit').required).toBe(true);
  });
  it('uses explicit specialist action aliases and canonical conditional Movement requirements',()=>{
    const manager='employment.direct_superior_and_history.superioremploymentid';
    expect(personnelWorkflowControl(manager,'movement').name).toBe('managerEmploymentId');
    expect(personnelWorkflowControl(manager,'hireCorrection').name).toBe('managerEmploymentId');
    expect(()=>personnelWorkflowControl('profile.personal_details.fullname','movement')).toThrow(/workflow binding/);
    const lastDay='employment_history.event_information.lastworkingdate';
    expect(personnelWorkflowControl(lastDay,'movement','edit',{movementEndDate:true}).required).toBe(true);
    expect(personnelWorkflowCarry('employment.approval_delegations.validto','delegationEnd')).toMatchObject({name:'endDate',type:'hidden',required:false});
    expect(personnelFormChoices('employment.organisation_assignment.employmenttype').map(option=>option.value)).toEqual(['full_time','part_time','contract','intern']);
  });
  it('rejects a stale specialized override when canonical type changes',()=>{
    const field=structuredClone(PERSONNEL_FIELDS.find(field=>field.id==='profile.contact_and_permanent_address.personalemail')!);
    field.type='date';expect(personnelFormMetadataIssue(field)).toContain('canonical type');
  });
  it('resolves each shared choice caption in all supported locales',()=>{
    for(const locale of ['en','ms','ta','th','vi','zh']) {
      const messages=JSON.parse(readFileSync(new URL('../messages/'+locale+'.json',import.meta.url),'utf8')) as Record<string,unknown>;
      for(const field of PERSONNEL_FIELDS.filter(field=>field.form))for(const choice of personnelFieldChoices(field)) {
        let value:unknown=messages;for(const part of choice.labelKey.split('.'))value=value&&typeof value==='object'?(value as Record<string,unknown>)[part]:undefined;
        expect(typeof value,locale+':'+choice.labelKey).toBe('string');
      }
    }
  });
  it('reads actual Birth Date JSX and every Employment period control, including unnamed controlled inputs',()=>{
    const read=(file:string)=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const valueIds=['probationvalue','extendedprobationvalue','noticebeforeconfirmationvalue','noticeafterconfirmationvalue'].map(key=>'employment.employment_dates_and_service.'+key);
    const unitIds=['probationunit','extendedprobationunit','noticebeforeconfirmationunit','noticeafterconfirmationunit'].map(key=>'employment.employment_dates_and_service.'+key);
    const cases:{file:string;dynamicBindings:Record<string,readonly string[]>}[]=[
      {file:'components/birth-date-fields.tsx',dynamicBindings:{fieldId:[birth]}},
      {file:'components/employment-period-fields.tsx',dynamicBindings:{fieldId:[initial],valueId:valueIds,unitId:unitIds}},
    ];
    for(const {file,dynamicBindings} of cases) {
      const result=auditPersonnelFormSource(file,read(file),PERSONNEL_FIELDS,{dynamicBindings});
      expect(result.controls).toBeGreaterThan(1);expect(result.issues).toEqual([]);
    }
  });
  it('fails negative controls for a new unregistered input, label/type/required bypass, unknown dynamic binding and stale exemption',()=>{
    const good=`<PersonnelField fieldId="${birth}"><input {...personnelInput('${birth}')} /></PersonnelField>`;
    expect(auditPersonnelFormSource('fixture.tsx',good,PERSONNEL_FIELDS).issues).toEqual([]);
    for(const bad of [
      good.replace('</PersonnelField>','<input name="newUnregisteredFact" /></PersonnelField>'),
      good.replace('PersonnelField fieldId=', 'Field label=').replace('</PersonnelField>','</Field>'),
      good.replace('<input ', '<input type="text" '),
      good.replace('<input ', '<input required '),
      good.replace(`personnelInput('${birth}')`,'personnelInput(unresolvedField)'),
    ])expect(auditPersonnelFormSource('fixture.tsx',bad,PERSONNEL_FIELDS).issues.length).toBeGreaterThan(0);
    expect(auditPersonnelFormSource('fixture.tsx',good,PERSONNEL_FIELDS,{exemptions:[{tag:'input',name:'missing',reason:'Transport-only ID owned by its server action.'}]}).issues[0].message).toContain('Stale');
  });
  it('validates hidden compatibility transport without assigning it the visible control caption',()=>{
    const source=`<PersonnelField fieldId="bank_statutory.income_tax_pcb.taxcircumstance"><input {...personnelCarry('bank_statutory.income_tax_pcb.taxcategory')} /></PersonnelField>`;
    expect(auditPersonnelFormSource('fixture.tsx',source,PERSONNEL_FIELDS).issues).toEqual([]);
    expect(auditPersonnelFormSource('fixture.tsx',source.replace('taxcategory','unknowntransport'),PERSONNEL_FIELDS).issues.some(issue=>issue.message.includes('Unknown Personnel'))).toBe(true);
    expect(auditPersonnelFormSource('fixture.tsx',source.replace('personnelCarry','personnelInput'),PERSONNEL_FIELDS).issues.some(issue=>issue.message.includes('different facts'))).toBe(true);
  });
  it('keeps Join Date display-only outside the explicitly declared information workflow',()=>{
    const id='employment.employment_dates_and_service.joindate',field=PERSONNEL_FIELDS.find(row=>row.id===id)!;
    expect(personnelFormWidget(id)).toBe('display');
    expect(()=>personnelInput(id)).toThrow('specialized renderer');
    expect(personnelWorkflowInput(id,'informationCorrection')).toMatchObject({'data-personnel-field':id,name:'joinDate',type:'date'});
    expect(()=>personnelWorkflowInput(id,'hireCorrection')).toThrow();
    expect(personnelFormMetadataIssue({...field,form:{...field.form,workflowWidgets:{informationCorrection:'number'}}})).toContain('contradicts canonical type');
    expect(personnelFormMetadataIssue({...field,form:{...field.form,workflowWidgets:{movement:'date'}}})).toContain('lacks an owning binding');
  });

});
