import {expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {readPayrollOvertimePatternCashTx} from '../core/payroll-overtime-pattern';

const readers=vi.hoisted(()=>({claims:vi.fn(),result:vi.fn(),state:vi.fn()}));
vi.mock('../packs/attendance/service',async load=>{
 const actual=await load<typeof import('../packs/attendance/service')>();
 return {...actual,readOvertimeCashSettlementsTx:readers.claims,
  readAttendanceFormulaResultTx:readers.result,attendanceFormulaResultStateTx:readers.state};
});

const date='2025-08-10';
const batch={id:'batch',companyId:'company',payPeriod:'2025-08',status:'closed'};
const result={id:'result',formulaId:'formula',revisionId:'revision',sourceHash:'frozen-result-hash',
 payComponentId:'component',quantity:'2',unit:'hours',rate:'30',amount:'60.00'};
const day={sourceId:'source',sourceDate:date,sourceRevision:5,calculationId:'calculation',sourceHash:'frozen-source-hash',
 coverage:'{[1754820000000,1754827200000)}',parts:[]};
const proof={
 version:'attendance-formula-overtime-1',companyId:batch.companyId,employmentId:'employment',from:date,to:date,
 batchId:batch.id,payPeriod:batch.payPeriod,results:[result],days:[day],
 money:{treatment:{epf:false,socso:true,pcb:true,hrdf:false},
  components:[{id:'component',code:'HISTORICAL',name:'Former overtime amount'}],
  floors:[{date,countryMinimumApplicable:true,minimumMinorUnits:'4500',periodEnd:'2025-08-31'}]},
 lines:[{resultId:result.id,revisionId:result.revisionId,sourceId:day.sourceId,componentId:'component',
  date,dayType:'workday',amountMinorUnits:'6000',physicalMinutes:120,countedMinutes:120}],
};

function fixture(matchesCoverage=true){
 readers.claims.mockResolvedValue([{settlement:{id:'claim',formulaBindingId:'binding'},source:{id:day.sourceId}}]);
 readers.result.mockResolvedValue({...result,companyId:batch.companyId,employmentId:proof.employmentId,
  periodFrom:date,periodTo:date});
 readers.state.mockResolvedValue({kind:'posted',batchId:batch.id});
 const execute=vi.fn()
  .mockResolvedValueOnce([{companyId:batch.companyId,employmentId:proof.employmentId,from:date,to:date,payload:proof}])
  .mockResolvedValueOnce([{id:result.id}])
  .mockResolvedValueOnce([{sourceId:day.sourceId,payload:day,matchesCoverage}])
  .mockResolvedValueOnce([{count:1}]);
 const select=vi.fn().mockReturnValue({from:()=>({where:async()=>[batch]})});
 const tx={execute,select} as unknown as Tx;
 const ctx={tenantId:'tenant',userId:'user'} as SessionContext;
 return {read:()=>readPayrollOvertimePatternCashTx(tx,ctx,{batchId:batch.id}),execute,select};
}

it('reads frozen closed-run money and source identities without recalculating them',async()=>{
 const {read,execute,select}=fixture();
 const cash=await read();
 expect(cash.lines).toMatchObject([{settlementId:'claim',sourceId:day.sourceId,calculationId:day.calculationId,
  sourceRevision:day.sourceRevision,formulaBindingId:'binding',earningItemName:'Former overtime amount',
  amountMinorUnits:'6000',treatment:proof.money.treatment,floorEvidence:{countryMinimumApplicable:true,minimumMinorUnits:'4500',periodEnd:'2025-08-31'}}]);
 expect(cash.byEmployment.get(proof.employmentId)).toEqual(cash.lines);
 expect(select).toHaveBeenCalledTimes(1);
 expect(execute).toHaveBeenCalledTimes(4);
});

it('refuses the frozen amount when the retained claim custody differs',async()=>{
 const {read}=fixture(false);
 await expect(read()).rejects.toMatchObject({code:'stale'});
});
