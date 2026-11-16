/** Contract Staff module facade. Domain schema and execution stay isolated from legacy onb/off. */
export * from '../../core/contract-management';
export * from '../../core/contract-shared-config';
export * from '../../core/contract-shared-read';
export * from '../../core/contract-shared-preview';
export * from '../../core/contract-shared-commands';
export {contractPreviewJobHandler} from '../../core/contract-shared-preview-job';
export {contractAutomationJobHandler} from '../../core/contract-shared-automation-job';
export {readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter,editContractSharedLetter,renderContractSharedLetter,type ContractSharedApproval,type ContractSharedLetter} from '../../core/contract-shared-signing';
