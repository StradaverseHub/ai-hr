import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hrDate from '../lib/hr-date';
import { defaultMasterColumn, runEmployeeMasterProjection, type EmployeeMasterSpec, type MasterOwnerRecord, type MasterSubject } from '../lib/employee-master-report';
import type { PersonnelFieldDescriptor } from '../lib/personnel-field-registry';

const company='11111111-1111-4111-8111-111111111111';
const field=(id:string,owner:string,ownerField:string,grain:'single'|'many'='many'):PersonnelFieldDescriptor=>({
  id,labelKey:'',label:id,tab:'Test',section:'Test',type:'text',owner,ownerField,grain,history:'dated',sensitivity:'personnel',scope:'both',
  report:{enabled:true,filter:true,sort:true,group:true,sum:false},import:{requiredCreate:false,requiredUpdate:false,order:0},
});
const familyName=field('family.name','dependent','name');
const familyRemark=field('family.remark','dependent','remark');
const latestFamilyName=field('family.latest-name','dependent','name');
const documentName=field('document.name','document','name');
const personName=field('person.name','person','name','single');
const fields=[familyName,familyRemark,latestFamilyName,documentName,personName];

function fixture(){
  const asAt=hrDate.todayInKualaLumpur();
  const nextDay=hrDate.todayInKualaLumpur(new Date(asAt+'T16:00:00.000Z'));
  const createdAt=asAt+'T04:00:00.000Z';
  const familyRows:MasterOwnerRecord[]=Array.from({length:64},(_,i)=>{
    const suffix=String(i).padStart(3,'0');
    return {id:'row-'+suffix,createdAt,values:{name:{value:'Child '+suffix},remark:{value:'Original remark '+suffix}}};
  });
  familyRows.splice(17,0,
    {id:'legacy',createdAt:null,values:{name:{value:'Legacy child'},remark:{value:'Legacy remark'}}},
    // This instant is still the UTC as-at date but already tomorrow in Kuala Lumpur.
    {id:'future-created',createdAt:asAt+'T16:00:00.000Z',values:{name:{value:'Future created'},remark:{value:'Exclude future created'}}},
    {id:'future-effective',effectiveFrom:nextDay,createdAt,values:{name:{value:'Future effective'},remark:{value:'Exclude future effective'}}},
  );
  const subject:MasterSubject={id:'family',kind:'employment',personId:'person-family',companyId:company,owners:{
    dependent:familyRows,
    document:[
      {id:'document-a',createdAt,values:{name:{value:'Earlier document tie'}}},
      {id:'document-z',createdAt,values:{name:{value:'Latest document tie'}}},
    ],
    person:[{id:'person-family',createdAt,values:{name:{value:'Family employee'}}}],
  }};
  const empty:MasterSubject={id:'empty',kind:'employment',personId:'person-empty',companyId:company,owners:{
    dependent:[],document:[],person:[{id:'person-empty',createdAt,values:{name:{value:'Empty employee'}}}],
  }};
  const spec:EmployeeMasterSpec={v:2,asAt,companyIds:[company],includeDrafts:false,
    columns:[{...defaultMasterColumn(familyName),records:'all'},{...defaultMasterColumn(familyRemark),records:'all'},defaultMasterColumn(latestFamilyName),defaultMasterColumn(documentName)],
    expression:{id:'root',type:'group',logic:'and',children:[{id:'named',type:'condition',field:personName.id,operator:'notBlank'}]},
    sorts:[{field:personName.id,dir:'asc'}],groups:[documentName.id],
    pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false},
  };
  return {asAt,nextDay,createdAt,subject,empty,spec};
}

afterEach(()=>vi.restoreAllMocks());

describe('Employee Master owner-record projection bounds',()=>{
  it('resolves created-at dates once per candidate while preserving expanded, latest and mixed-owner values',()=>{
    const {subject,empty,spec}=fixture();
    const subjects=[subject,empty],before=structuredClone(subjects);
    // Count calls through the real Malaysia date helper; do not replace its date semantics.
    const dateResolution=vi.spyOn(hrDate,'todayInKualaLumpur');
    const result=runEmployeeMasterProjection(spec,fields,subjects,spec.asAt);

    expect(result).toMatchObject({employeeCount:2,personCount:2,totalRows:66});
    expect(result.sections).toHaveLength(1);
    const section=result.sections[0];
    expect(section.grain).toBe('dependent');
    expect(section.rows[0]).toMatchObject({subjectId:'empty',recordId:null,cells:[
      {value:null,unavailable:'not-recorded'},{value:null,unavailable:'not-recorded'},
      {value:null,unavailable:'not-recorded'},{value:null,unavailable:'not-recorded'},
    ]});
    const familyRows=section.rows.filter(row=>row.subjectId==='family');
    expect(familyRows.map(row=>[row.recordId,...row.cells.map(cell=>cell.value)])).toEqual([
      ['legacy','Legacy child','Legacy remark','Child 063','Latest document tie'],
      ...Array.from({length:64},(_,i)=>{
        const suffix=String(i).padStart(3,'0');
        return ['row-'+suffix,'Child '+suffix,'Original remark '+suffix,'Child 063','Latest document tie'];
      }),
    ]);
    expect(familyRows.every(row=>row.cells[2].sourceRecordId==='row-063'&&row.cells[3].sourceRecordId==='document-z')).toBe(true);
    expect(section.groups.map(group=>[group.values[0].value,group.rowCount])).toEqual([[null,1],['Latest document tie',65]]);
    expect(subjects).toEqual(before);
    // 64 dated Family rows + one future-created Family row + two Document rows + two Person rows.
    // The effective-dated future row and undated legacy row need no created-at conversion.
    expect(dateResolution).toHaveBeenCalledTimes(69);
  });

  it('does not retain records across invocations, source changes or as-at dates',()=>{
    const {subject,spec,createdAt,nextDay}=fixture();
    const latestSpec={...spec,columns:[defaultMasterColumn(latestFamilyName)],sorts:[],groups:[]};
    const latest=()=>runEmployeeMasterProjection(latestSpec,fields,[subject],nextDay).sections[0].rows[0].cells[0];
    expect(latest()).toMatchObject({value:'Child 063',sourceRecordId:'row-063'});

    subject.owners.dependent.push({id:'zzz-new-source',createdAt,values:{name:{value:'New source row'}}});
    expect(latest()).toMatchObject({value:'New source row',sourceRecordId:'zzz-new-source'});

    latestSpec.asAt=nextDay;
    expect(latest()).toMatchObject({value:'Future effective',sourceRecordId:'future-effective'});
  });
});
