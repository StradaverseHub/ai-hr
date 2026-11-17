/** Contract Staff module facade. Domain schema and execution stay isolated from legacy onb/off. */
export * from '../../core/contract-management';
export * from '../../core/contract-shared-config';
export * from '../../core/contract-shared-tasks';
export * from '../../core/contract-shared-read';
export * from '../../core/contract-shared-tracker';
export * from '../../core/contract-shared-period';
export * from '../../core/contract-shared-setup';
export * from '../../core/contract-shared-preview';
export * from '../../core/contract-shared-commands';
export * from '../../core/contract-shared-workspace';
export * from '../../core/contract-shared-tasks';
export {recordContractSharedDecline,readContractSharedEndingActions,type ContractSharedEndingActions} from '../../core/contract-shared-ending';
export {contractPreviewJobHandler} from '../../core/contract-shared-preview-job';
export {contractAutomationJobHandler} from '../../core/contract-shared-automation-job';
export {readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter,editContractSharedLetter,bindContractSharedEmployee,renderContractSharedLetter,type ContractSharedApproval,type ContractSharedLetter} from '../../core/contract-shared-signing';
// Ordinary Node notification workers consume this facade without loading the
// framework-only builders. Literal imports retain the builders' server boundary.
type ConfigurationService = typeof import('../../core/contract-configuration');
async function loadConfiguration(): Promise<ConfigurationService> {
 const loaded = await import('../../core/contract-configuration');
 return (loaded as { default?: ConfigurationService }).default ?? loaded;
}
export const contractConfigurationWorkflows: ConfigurationService['contractConfigurationWorkflows'] = async (...args) => (await loadConfiguration()).contractConfigurationWorkflows(...args);
export const contractConfigurationDirectory: ConfigurationService['contractConfigurationDirectory'] = async (...args) => (await loadConfiguration()).contractConfigurationDirectory(...args);
export const contractConfigurationTemplates: ConfigurationService['contractConfigurationTemplates'] = async (...args) => (await loadConfiguration()).contractConfigurationTemplates(...args);
export {listContractSharedPostings,readContractSharedPosting,readContractSharedPostingSummary,approveContractSharedPosting,editContractSharedPosting,confirmContractSharedPay,contractSharedPostingWorkPage,type ContractSharedPosting,type ContractSharedPostingPage,type ContractSharedPostingSummary} from '../../core/contract-shared-postings';

export * from '../../core/contract-shared-template-preview';
