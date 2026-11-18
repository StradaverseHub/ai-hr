import {expect,it} from 'vitest';
import {SEMANTIC_ENTITIES,SEMANTIC_READS} from '../core/semantic-model/entities';
import {discloseToolOutput,DisclosureLedger} from '../core/harness/disclosure';
import {capturePrivateAssistantTask,privateAssistantCatalogue} from '../lib/ai/provider-assistant-policy';

const projection={version:1,companyId:'81000000-0000-4000-8000-000000000001',mappingReceiptId:'81000000-0000-4000-8000-000000000002',
 source:{employmentId:'81000000-0000-4000-8000-000000000003',departmentId:'81000000-0000-4000-8000-000000000004',employmentType:'contract',validFrom:'1999-02-17',createdAt:'1999-02-17T03:04:05.000Z'},replacements:[]};
it('does not register the raw audit ledger as an assistant semantic read owner',()=>{
 const owners=SEMANTIC_ENTITIES.flatMap(entity=>entity.owners);
 expect(owners).not.toContain('core/read.ts#auditEvents');
 expect(owners).not.toContain('core/read.ts#employeeAudit');
 expect(owners).not.toContain('core/read.ts#auditEventsCount');
 expect(SEMANTIC_READS.some(read=>['auditEvents','employeeAudit','audit_events','employee_audit'].includes(read.name))).toBe(false);
});
it('keeps undeclared projection values out of the actual employee-profile disclosure',()=>{
 const disclosed=discloseToolOutput('employee_profile','employment_profile',{ok:true,employee:{projection}},new DisclosureLedger('fictional-review'));
 const wire=JSON.stringify(disclosed.value);
 for(const raw of [projection.companyId,projection.mappingReceiptId,projection.source.employmentId,projection.source.departmentId,projection.source.validFrom,projection.source.createdAt,projection.source.employmentType])expect(wire).not.toContain(raw);
});
it('rejects passive audit witnesses at the strict private assistant provider serializer',()=>{
 const catalogue=privateAssistantCatalogue('work_profile',[]);
 expect(()=>capturePrivateAssistantTask(catalogue)).not.toThrow();
 expect(()=>capturePrivateAssistantTask({...catalogue,projection})).toThrow();
});
