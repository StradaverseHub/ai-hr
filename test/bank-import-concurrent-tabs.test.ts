import {createHash} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {runBankImportTick} from '../core/bank-import-worker';
import {commitEmployeeImport} from '../core/import';
import {parseCsvRecords} from '../lib/csv';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('lets two users upload different tabs of one workbook and reserves exact duplicates',async()=>{
  await resetDb();
  const base=await seedBase(),first=adminCtx(base);
  const second={...first,userId:await createAppUser(base.tenantId,null,'hr_admin')};
  const records=parseCsvRecords([
    'full_name,email,department,hired_on,ic_number,basic_salary,employee_code',
    'Fictional Bank East,east@fixture.test,Finance,2026-01-05,900101105555,5000,BANK-EAST',
    'Fictional Bank West,west@fixture.test,Finance,2026-01-05,900101105556,5000,BANK-WEST',
  ].join('\n')).records;
  expect(await commitEmployeeImport(first,{companyId:base.companyId,records})).toMatchObject({imported:2});

  const book=XLSX.utils.book_new();
  const tabs=['East','West'];
  for(const [slot,tab] of tabs.entries()){
    const code=['BANK-EAST','BANK-WEST'][slot],tax=['TEAST','TWEST'][slot];
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['employee_code','tax_number'],[code,tax]]),tab);
  }
  const bytes:Buffer=XLSX.write(book,{type:'buffer',bookType:'xlsx'});
  const input={name:'shared-bank.xlsx',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')};

  // A pre-selection workbook job reserves the unknown default sheet across users.
  const legacy=await createBankImportJob(first,input);
  await expect(createBankImportJob(second,{...input,worksheet:tabs[1]})).rejects.toMatchObject({status:409});
  await bankImportCommand(first,legacy.job.id,'cancel');

  const firstTab=await createBankImportJob(first,{...input,worksheet:tabs[0]});
  await expect(createBankImportJob(second,{...input,worksheet:tabs[0]})).rejects.toMatchObject({status:409});
  await bankImportCommand(first,firstTab.job.id,'cancel');

  const actors=[first,second];
  const submissions=await Promise.all(actors.map(async(actor,slot)=>{
    const {job,existing}=await createBankImportJob(actor,{...input,worksheet:tabs[slot]});
    expect(existing).toBe(false);
    await uploadBankImportChunk(actor,job.id,0,bytes);
    await bankImportCommand(actor,job.id,'validate');
    return job.id;
  }));
  expect(submissions[0]).not.toBe(submissions[1]);
  await expect(getBankImportJob(second,submissions[0])).rejects.toMatchObject({status:404});
  await expect(createBankImportJob(second,{...input,worksheet:tabs[0]})).rejects.toMatchObject({status:409});
  await expect(createBankImportJob(first,input)).rejects.toMatchObject({status:409});
  expect(await createBankImportJob(first,{...input,worksheet:tabs[0]})).toMatchObject({existing:true,job:{id:submissions[0]}});

  const progress=()=>Promise.all(actors.map(async(actor,slot)=>(await getBankImportJob(actor,submissions[slot])).job));
  for(let unit=0;unit<20 && !(await progress()).every(job=>job.state==='ready');unit++)await runBankImportTick(owner.client);
  expect(await progress()).toMatchObject(tabs.map(tab=>({sourceWorksheet:tab,state:'ready',valid:1,total:1})));
  await Promise.all(actors.map((actor,slot)=>bankImportCommand(actor,submissions[slot],'confirm')));
  for(let unit=0;unit<20 && !(await progress()).every(job=>job.state==='completed');unit++)await runBankImportTick(owner.client);
  expect(await progress()).toMatchObject(tabs.map(tab=>({sourceWorksheet:tab,state:'completed',saved:1,failed:0})));
  expect([...await owner.client`
    select e.employee_code,s.tax_number from employment e join employee_statutory_my s on s.person_id=e.person_id
    where e.tenant_id=${base.tenantId}::uuid and e.employee_code in ('BANK-EAST','BANK-WEST') order by e.employee_code
  `]).toEqual([{employee_code:'BANK-EAST',tax_number:'TEAST'},{employee_code:'BANK-WEST',tax_number:'TWEST'}]);
},180_000);
