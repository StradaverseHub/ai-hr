/** Resignation subdomain boundary of Lifecycle. All authority remains in the native transactional service. */
export {
 ResignationJourneyError,resignationCase,resignationEmployeeView,resignationInbox,
 submitResignationJourney,commandResignationJourney,uploadResignationFile,downloadResignationLetter,
 resumeResignationPostingTx,resignationConfigurationCases,resignationWorkflowDryRun,installResignationDefaults,
 readResignationJourneyAttachment,sweepResignationJourneys,resignationForOffboardingCase,
 downloadResignationOffboardingLetter,resignationOffboardingTemplateScopeTx,
} from '../../../core/resignation-journey';
export type * from '../../../lib/resignation-journey';
export {resignationCaseCommunications,resignationOffboardingCommunications,requestResignationMessageTest,editResignationCaseMessage} from '../../../core/resignation-communications';
export type * from '../../../lib/resignation-communications';
