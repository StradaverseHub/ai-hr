/** Complete uninstalled native policy proof in an actual owned one-worker job cluster. */
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {registerRewardsAuditPolicyNativeCases} from './prototypes/rewards-audit-policy-native-cases';
const admission=admitSingletonTest('test/rewards-audit-policy-native.test.ts');
registerRewardsAuditPolicyNativeCases(admission.evidenceDirectory);
