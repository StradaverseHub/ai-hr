import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createMasterReportDeliveryService,type MasterDeliveryTarget,type MasterDeliveryDependencies} from '../deploy/identity-email/reports';
const setup=()=>{
 const target:MasterDeliveryTarget={tenantId:randomUUID(),ownerUserId:randomUUID(),recipientUserId:randomUUID(),recipientEmploymentId:randomUUID(),reportId:randomUUID(),reportVersion:1,scheduleId:randomUUID(),scheduleRevision:randomUUID(),reviewedDigest:'a'.repeat(64),subject:'fictional-recipient',email:'recipient@fixture.test',locale:'en',consentAfterSequence:0,policyAfterSequence:0,consentUpdatedAt:'2026-01-01T00:00:00.000001Z',policyUpdatedAt:'2026-01-01T00:00:00.000001Z',consentVerifiedAt:'2026-01-01T00:00:00.000001Z',ownerGrants:[],recipientGrants:[],ownerPersonId:null,recipientPersonId:null,accessStamp:'b'.repeat(64),companyIds:[randomUUID()]};
 const deps:MasterDeliveryDependencies={origin:'https://fixture.test',ready:vi.fn(async()=>true),target:vi.fn(async()=>target),verifyRecipient:vi.fn(async()=>'verified' as const),prepare:vi.fn(async()=>({bytes:new Uint8Array([1,2,3]),filename:'Employee-Master.xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',rowCount:2,scopeIds:target.companyIds})),authorize:vi.fn(async()=>true),start:vi.fn(async()=>true),finish:vi.fn(async()=>true),send:vi.fn(async()=>{})};
 return {target,deps,run:createMasterReportDeliveryService(deps),input:{op:'sendReport' as const,occurrenceId:randomUUID(),leaseToken:randomUUID()}};
};
it('accepts only durable IDs, prepares the authorized file and verifies identity again before SMTP',async()=>{
 const {run,deps,input,target}=setup();expect(await run(input)).toEqual({outcome:'sent'});
 expect(deps.prepare).toHaveBeenCalledWith(input.occurrenceId,input.leaseToken,target);expect(deps.verifyRecipient).toHaveBeenCalledTimes(2);
 expect(deps.start).toHaveBeenCalledWith(input.occurrenceId,input.leaseToken,target);
 expect(deps.send).toHaveBeenCalledTimes(1);expect(deps.finish).toHaveBeenCalledWith(input.occurrenceId,input.leaseToken,'sent',null,expect.objectContaining({rowCount:2}));
 const poisoned=setup();await expect(poisoned.run({...poisoned.input,email:'other@fixture.test',bytes:'caller-content'})).rejects.toThrow();expect(poisoned.deps.target).not.toHaveBeenCalled();
});
it('refuses changed recipients after generation and never sends or starts SMTP',async()=>{
 const {run,deps,input}=setup();vi.mocked(deps.verifyRecipient).mockResolvedValueOnce('verified').mockResolvedValueOnce('changed');
 expect(await run(input)).toEqual({outcome:'skipped'});expect(deps.send).not.toHaveBeenCalled();expect(deps.start).not.toHaveBeenCalled();
});
it('leaves another started claim alone and holds ambiguous transport failures as uncertain',async()=>{
 const busy=setup();vi.mocked(busy.deps.start).mockResolvedValue(false);expect(await busy.run(busy.input)).toEqual({outcome:'busy'});expect(busy.deps.finish).not.toHaveBeenCalled();expect(busy.deps.send).not.toHaveBeenCalled();
 const uncertain=setup();vi.mocked(uncertain.deps.send).mockRejectedValue(new Error('Acknowledgement lost'));
 expect(await uncertain.run(uncertain.input)).toEqual({outcome:'uncertain'});expect(uncertain.deps.send).toHaveBeenCalledTimes(1);
 expect(uncertain.deps.finish).toHaveBeenCalledWith(uncertain.input.occurrenceId,uncertain.input.leaseToken,'uncertain','uncertain',expect.any(Object));
});
it('does not rewrite successful SMTP as rejection when the durable result cannot be recorded',async()=>{
 const {run,deps,input}=setup();vi.mocked(deps.finish).mockResolvedValue(false);
 await expect(run(input)).rejects.toThrow('outcome could not be recorded');expect(deps.send).toHaveBeenCalledTimes(1);expect(deps.finish).toHaveBeenCalledTimes(1);
});

it('does not verify again or start SMTP after canonical access authorization is revoked during generation',async()=>{
 const {run,deps,input}=setup();deps.authorize=vi.fn(async()=>false);expect(await run(input)).toEqual({outcome:'skipped'});expect(deps.verifyRecipient).toHaveBeenCalledTimes(1);expect(deps.start).not.toHaveBeenCalled();expect(deps.send).not.toHaveBeenCalled();expect(deps.finish).toHaveBeenCalledWith(input.occurrenceId,input.leaseToken,'skipped','notEligible');
});

it('refuses attachment metadata from a different scope before starting SMTP',async()=>{const {run,deps,input}=setup();vi.mocked(deps.prepare).mockResolvedValue({bytes:new Uint8Array([1]),filename:'Employee-Master.xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',rowCount:1,scopeIds:[randomUUID()]});expect(await run(input)).toEqual({outcome:'failed'});expect(deps.start).not.toHaveBeenCalled();expect(deps.send).not.toHaveBeenCalled();});
