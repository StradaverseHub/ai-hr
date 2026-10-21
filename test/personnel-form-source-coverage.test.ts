import {describe,expect,it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {personnelFormSources,personnelImportSourceReader,PERSONNEL_FORM_ROOTS} from './helpers/personnel-form-files';
import {auditPersonnelFormSource,type PersonnelSourceExemption} from './helpers/personnel-form-source';
const root=fileURLToPath(new URL('..',import.meta.url));
const exemptions=JSON.parse(readFileSync(new URL('./fixtures/personnel-form-exemptions.json',import.meta.url),'utf8')) as Record<string,PersonnelSourceExemption[]>;
describe('actual mounted Personnel form inventory',()=>{
  it('binds the classification fact and exempts only its one dedicated-command subject pointer',()=>{
    const file='app/admin/personnel/[employmentId]/page.tsx',source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const start=source.indexOf('const dataClassificationCard'),end=source.indexOf('const directSuperiorCard',start);
    expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start+500);const card=source.slice(start,end);
    expect(card).toContain('action={setTestRecordAction}');expect(card).toContain('fieldId="employment.data_classification.istestrecord"');
    const binding="personnelControl('employment.data_classification.istestrecord','edit')";expect(card).toContain(binding);
    expect(card).toContain('defaultValue={String(classification.isTestRecord)}');expect(card).toContain('value="false"');expect(card).toContain('value="true"');
    const transport=exemptions[file].filter(item=>item.context==='dataClassificationCard');expect(transport).toHaveLength(1);
    expect(transport[0]).toMatchObject({tag:'input',name:'employmentId',hidden:true,occurrences:1});
    expect(transport[0].reason).toContain('setTestRecordAction');expect(exemptions[file].some(item=>item.name==='isTestRecord')).toBe(false);
    const altered=source.replace(binding,'unregisteredClassificationControl()');expect(altered).not.toBe(source);
    expect(auditPersonnelFormSource(file,altered,PERSONNEL_FIELDS,{exemptions:exemptions[file],resolveImportSource:personnelImportSourceReader(root)}).issues.some(issue=>issue.message.includes('Unbound Personnel control'))).toBe(true);
  });
  it('checks every real control reached from Personnel, draft completion and short Create',()=>{
    const {files,boundaries}=personnelFormSources(root);
    for(const entry of PERSONNEL_FORM_ROOTS)expect(files.has(entry),entry).toBe(true);
    for(const file of Object.keys(exemptions))expect(files.has(file),'Stale exemption module: '+file).toBe(true);
    let controlCount=0;
    for(const [file,source] of files){
      const result=auditPersonnelFormSource(file,source,PERSONNEL_FIELDS,{exemptions:exemptions[file],resolveImportSource:personnelImportSourceReader(root)});
      if(!result.controls){expect(exemptions[file]??[],file).toEqual([]);continue;} // Layout-only modules are discovered, but declare no inputs.
      controlCount+=result.controls;
      expect(result.issues,file).toEqual([]);
    }
    expect(controlCount).toBeGreaterThan(100);
    expect(boundaries.get('components/profile-option-select.tsx')).toContain('owning Personnel widget');
  });
  it('refuses new controls and caption/type/required overrides in the real mounted draft source',()=>{
    const file='app/admin/personnel/new/wizard.tsx';
    const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const control='<input {...personnelInput("profile.personal_details.fullname", \'draft\')}';
    expect(source).toContain(control);
    for(const changed of [
      source.replace(control,'<input name="unregisteredPersonnelFact"'),
      source.replace(control,control+' type="date"'),
      source.replace(control,control+' required'),
      source.replace('fieldId={"profile.personal_details.fullname"}','fieldId={"profile.contact_and_permanent_address.primaryemail"}'),
    ])expect(auditPersonnelFormSource(file,changed,PERSONNEL_FIELDS).issues.length).toBeGreaterThan(0);
  });
  it('discovers and audits all dated calendar facts while exempting only the two guarded record pointers',()=>{
    const file='app/admin/personnel/[employmentId]/holiday-calendar-assignments.tsx';
    const {files}=personnelFormSources(root),source=files.get(file);
    expect(source,'the mounted calendar form must remain in the Personnel inventory').toBeDefined();
    if(!source)throw new Error('Mounted calendar form missing');
    const audit=(text:string)=>auditPersonnelFormSource(file,text,PERSONNEL_FIELDS,{exemptions:exemptions[file],resolveImportSource:personnelImportSourceReader(root)});
    expect(audit(source)).toMatchObject({controls:5,issues:[]});
    expect(exemptions[file].map(item=>({tag:item.tag,name:item.name,hidden:item.hidden,occurrences:item.occurrences})))
      .toEqual(['employmentId','replacesId'].map(name=>({tag:'input',name,hidden:true,occurrences:1})));
    const binding="personnelInput('attendance.dated_holiday_calendar.startdate'";
    expect(source).toContain(binding);
    const unknown=source.replace(binding,"personnelInput('unregistered.calendar.startdate'");
    expect(audit(unknown).issues.some(issue=>issue.message.includes('Unknown Personnel form field'))).toBe(true);
    const raw=source.replace(binding,"unregisteredCalendarInput('attendance.dated_holiday_calendar.startdate'");
    expect(audit(raw).issues.some(issue=>issue.message.includes('Unbound Personnel control'))).toBe(true);
    expect(exemptions).not.toHaveProperty('components/leave/LeaveDetailsPanel.tsx');
  });
  it('resolves actual imported Movement descriptors and refuses altered keys/maps/imports with only existing plumbing exemptions',()=>{
    const file='app/admin/personnel/[employmentId]/movement-new-event.tsx',source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const resolveImportSource=personnelImportSourceReader(root),audit=(text:string,reader=resolveImportSource)=>auditPersonnelFormSource(file,text,PERSONNEL_FIELDS,{exemptions:exemptions[file],resolveImportSource:reader});
    const actual=audit(source);expect(actual.controls).toBeGreaterThan(15);expect(actual.issues).toEqual([]);
    expect(source).toContain("movementField('companyId')");expect(source).toContain('movementField(name)');
    expect(audit(source.replace("personnelWorkflowControl(movementField('companyId')","personnelWorkflowControl(movementField('unregisteredFact')")).issues.some(issue=>issue.message.includes('Unresolved Personnel binding'))).toBe(true);
    expect(audit(source.replace("from '@/lib/movement-form-contract'","from '@/lib/unregistered-movement-contract'")).issues.some(issue=>issue.message.includes('Unresolved Personnel binding'))).toBe(true);
    const altered=(from:string,specifier:string)=>{const text=resolveImportSource(from,specifier);return specifier==='@/lib/movement-form-contract'?text?.replace('employment.organisation_assignment.companyname','unknown.personnel.binding'):text;};
    expect(audit(source,altered).issues.some(issue=>issue.message.includes('Unknown Personnel form field: unknown.personnel.binding'))).toBe(true);
    const computed=(from:string,specifier:string)=>{const text=resolveImportSource(from,specifier);return specifier==='@/lib/movement-form-contract'?text?.replace('\"companyId\": \"employment.organisation_assignment.companyname\"','\"companyId\": dynamicDescriptor()'):text;};
    expect(audit(source,computed).issues.some(issue=>issue.message.includes('Unresolved Personnel binding'))).toBe(true);
  });
  it('requires exact owner reasons and counts for every named plumbing/filter exemption',()=>{
    for(const [file,items] of Object.entries(exemptions))for(const item of items){
      expect(item.reason.trim().length,file).toBeGreaterThan(20);
      expect(item.context,file).toBeTruthy();
      expect(item.occurrences,file).toBeGreaterThan(0);
      if(item.hidden)expect(item.name||item.nameExpression,file).toBeTruthy();
    }
    const file='app/admin/personnel/new/create-form.tsx';
    const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const extra=source.replace('<input\n                    type="radio"','<input name="employeeIdMode" type="radio" /><input\n                    type="radio"');
    expect(extra).not.toBe(source);
    expect(auditPersonnelFormSource(file,extra,PERSONNEL_FIELDS,{exemptions:exemptions[file],resolveImportSource:personnelImportSourceReader(root)}).issues.some(issue=>issue.message.includes('occurrence changed'))).toBe(true);
  });
});
