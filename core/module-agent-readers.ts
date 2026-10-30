/** Closed canonical module projections. Receives the Assistant owner's actual transaction/lifetime.
 * No provider, posted employee/company selector, generic query, cache or effect entry point exists.
 */
import type { SessionContext, Tx } from '../db/client';
import { AiGatewayError } from '../lib/ai/types';
import { MODULE_AGENT_CAPABILITIES, isAgentModuleCode, type AgentModuleCode } from '../lib/ai/module-agents';
import {MODULE_AGENT_ACTIONS,parseModuleAgentActionNomination} from '../lib/ai/module-agent-actions';
import {moduleHumanActionHandoffs} from '../lib/ai/module-human-handoffs';
import {isAdmin} from '../lib/authz-model';
import {assistantAgentStatusTx} from './ai-management';
import { assertAiPrincipalTx } from './ai-principal';
import { assertMayUseAssistant } from './assistant-grant';
import { assertAiActionUnpausedTx } from './ai-governance';
import { assertModuleEnabled, resolveEntitlementsTx, isModuleEnabled } from './entitlements';
import * as reads from './read';
import { readinessSnapshot } from './record-readiness';
import {projectMineLeaveBalance} from './assistant-leave-projection';
import {recordedPayrollComparisonCurrency} from '../lib/payroll-comparison-source';
import { storedComponentLines } from './payslip-earning-lines';
import { listDocuments } from './knowledge-base';
import { listNotifications } from './notifications';
import {ownPerformanceWorkStatusesTx} from '../packs/performance/service';
import { getMyOnboarding } from '../packs/lifecycle/service';
import { listRewardUnits } from '../packs/rewards/service';
import { ownClaimStatuses } from '../packs/claims/service';
import { listSchemaTables } from './schema-explorer';
import {ownTestingWorkStatusesTx} from './system-testing-workspace';

const unavailable = (): never => { throw new AiGatewayError('Assistant data access could not be confirmed.'); };
const storedAmount = (value: unknown): string | number | null => typeof value === 'number' && Number.isFinite(value) ? value :
  typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 40 ? value : null;
const storedLabel = (value: unknown): string | null => typeof value === 'string' && value.length <= 250 ? value : null;
const bounded = <T>(rows: T[]) => ({ rows: rows.slice(0, 25), truncated: rows.length > 25 });
export function createModuleAgentReaders(ctx: SessionContext, tx: Tx, active: () => boolean) {
  const moduleWork = async (module: AgentModuleCode) => {
    if (!active() || !isAgentModuleCode(module)) return unavailable();
    await assertAiPrincipalTx(tx, ctx);
    const fresh = { ...ctx, entitlements: await resolveEntitlementsTx(tx, ctx.tenantId) };
    await assertMayUseAssistant(fresh, tx);
    await assertAiActionUnpausedTx(tx, fresh, 'hr_assistant');
    assertModuleEnabled(fresh, module);
    const capability = MODULE_AGENT_CAPABILITIES.find(entry => entry[0] === module)![1];
    // All Assistant/orchestrator paths share this closed module boundary. A declaration is not
    // authority: the actual current principal/module checks above still precede every source read.
    const nominated=parseModuleAgentActionNomination({module,action:MODULE_AGENT_ACTIONS[module].read.id,phase:'read'});
    if(nominated.kind!=='read'||nominated.module!==module||nominated.capability!==capability)return unavailable();
    const own = async () => {
      const subjects = await reads.myOwnEmploymentSubjectsTx(tx, fresh);
      // Refuse rather than silently omit an unprotected subject from the claimed own-person scope.
      if (subjects.length > 16) return unavailable();
      return subjects;
    };
    const ready = async (malaysian: boolean) => {
      const subjects = (await own()).filter(row => !malaysian || row.country === 'MY');
      if (!fresh.personId || subjects.length === 0) return { employees: 0, ready: 0, gaps: [] };
      const result = await readinessSnapshot(tx, 0, false, { employmentIds: subjects.map(row => row.employmentId), personId: fresh.personId });
      return { employees: result.view.employees, ready: result.view.ready,
        gaps: result.view.gaps.map(gap => ({ id: gap.id, blocks: gap.blocks, count: gap.count })) };
    };
    let data: unknown;
    switch (module) {
      case 'employees': data = bounded((await own()).map(row => ({ employmentId: row.employmentId, employeeCode: row.employeeCode,
        company: row.company, hiredOn: row.hiredOn, terminatedOn: row.terminatedOn, status: row.status }))); break;
      case 'org': data = bounded(await Promise.all((await own()).map(async row => ({ employmentId: row.employmentId,company:row.company,
        reportingLines: (await reads.reportingLinesFor(fresh, row.employmentId, tx)).managers.map(line => ({ lineType: line.lineType, name: line.name, employeeCode: line.employeeCode })) })))); break;
      case 'leave': data = bounded(await Promise.all((await own()).map(async row => ({ employmentId: row.employmentId,company:row.company,
        balances: (await reads.leaveBalances(fresh, row.employmentId, undefined, { includeArchived: false }, tx)).map(projectMineLeaveBalance) })))); break;
      case 'ess': data = await ready(false); break;
      case 'country-my': data = await ready(true); break;
      case 'approvals': assertModuleEnabled(fresh,'leave'); data = bounded((await Promise.all((await own()).map(async row => {
        const requests = await reads.leaveRequestsFor(fresh, row.employmentId, undefined, tx);
        return requests.map(request => ({ id: request.id,company:row.company, status: request.status,leaveType:request.leaveType,startDate:request.startDate,endDate:request.endDate,days:request.days,hours:request.hours,durationType:request.durationType,hasRejectedDates:request.hasRejectedDates }));
      }))).flat()); break;
      case 'knowledge_base': data = bounded((await listDocuments(fresh, {}, tx)).map(row => ({ id: row.id, title: row.title,
        category: row.category, updatedAt: row.updatedAt }))); break;
      case 'payroll': {
        const rows = await reads.myPayslips(fresh, (await own()).map(row => row.employmentId), true, tx);
        data = bounded(rows.filter(row => row.released).map(row => ({ id: row.id, payPeriod: row.payPeriod,
          runType: row.runType, runSeq: row.runSeq,company:row.company,currency:recordedPayrollComparisonCurrency(row.statutory,row.companyId), gross: row.gross, deductions: row.deductions, net: row.net })));
        break;
      }
      case 'typed_pay_components': {
        assertModuleEnabled(fresh, 'payroll');
        const rows = await reads.myPayslips(fresh, (await own()).map(row => row.employmentId), true, tx);
        data = bounded(rows.filter(row => row.released).map(row => ({ payslipId: row.id, payPeriod: row.payPeriod,currency:recordedPayrollComparisonCurrency(row.statutory,row.companyId),
          // Stored kernel amounts only. Missing historical detail stays absent; never re-derive money.
          lines: bounded(storedComponentLines(row.statutory).map(line => ({ code: storedLabel(line.code),
            name: storedLabel(line.name), amount: storedAmount(line.amount) }))) })));
        break;
      }
      case 'multi_cycle_payroll': assertModuleEnabled(fresh, 'payroll'); data = bounded((await reads.myReleasedPayslipRuns(fresh, tx)).map(run => ({ payslipId: run.payslipId, payPeriod: run.payPeriod, cycleName: run.cycleName, runType: run.runType, runSeq: run.runSeq }))); break;
      case 'attendance': data = bounded((await Promise.all((await own()).map(async row => {
        const records = await reads.myAttendance(fresh, row.employmentId, 14, tx);
        return records.map(record => ({ employmentId: row.employmentId,company:row.company, date: record.date, status: record.status,
          workedMinutes: record.workedMinutes, otMinutes: record.otMinutes }));
      }))).flat()); break;
      case 'claims': data = await ownClaimStatuses(fresh, 25, tx); break;
      case 'performance': data = await ownPerformanceWorkStatusesTx(tx,fresh,25); break;
      case 'rewards': data = bounded((await listRewardUnits(fresh, (await reads.allowedCompanies(fresh, tx)).map(row => row.id), tx))
        .map(row => ({ id: row.id, kind: row.kind, year: row.year, status: row.status, revision: row.revision,cycle:row.cycle,company:row.company,unit:row.unit }))); break;
      case 'lifecycle': {
        const result = await getMyOnboarding(fresh, tx);
        data = result ? { status: result.status, progress: result.progress,
          steps: result.steps.map(step => ({ key: step.key,label:step.label, applicable: step.applicable, done: step.done })) } : null;
        break;
      }
      case 'toil': data = bounded(await Promise.all((await own()).map(async row => {
        const ledger = await reads.replacementLeaveLedger(fresh, row.employmentId, tx);
        return { employmentId: row.employmentId, active: ledger.active, taken: ledger.taken, expired: ledger.expired,
          convertedToPay: ledger.convertedToPay, soonestExpiry: ledger.soonestExpiry, leaveUnit: ledger.leaveUnit,
          rows: bounded(ledger.rows.map(credit => ({ id: credit.id, workedDate: credit.workedDate,
            expiresOn: credit.expiresOn, daysCredited: credit.daysCredited, daysTaken: credit.daysTaken,
            status: credit.status, remaining: credit.remaining }))) };
      }))); break;
      case 'notifications': data = bounded((await Promise.all((await own()).map(async row =>
        (await listNotifications(fresh, row.employmentId, { limit: 25 }, tx)).map(record => ({ id: record.id,
          readAt: record.readAt, createdAt: record.createdAt })) ))).flat()); break;
      case 'system_explorer': {
        const result = await listSchemaTables(fresh, tx);
        data = { tables: bounded(result.tables.map(row => ({ table: row.table, module: row.moduleCode }))), withheldTables: result.withheldTables }; break;
      }
      case 'system_testing': data = await ownTestingWorkStatusesTx(tx,fresh,25); break;
      case 'assistant': data = { capabilities: MODULE_AGENT_CAPABILITIES.filter(([code]) => isModuleEnabled(fresh, code)&&(code!=='system_explorer'||isAdmin(fresh)))
        .map(([code, binding]) => ({ module: code, capability: binding, authority: 'rechecked-at-canonical-source' })), effects: 'human-confirmation-only',
        ...(isAdmin(fresh)?{adminAgentStatus:await assistantAgentStatusTx(tx,fresh)}:{}) }; break;
      default: return unavailable();
    }
    if (!active()) return unavailable();
    return { module, capability, scope: 'current-caller', data, humanActions:moduleHumanActionHandoffs(module) };
  };
  return Object.freeze({ moduleWork });
}
