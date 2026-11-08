/** Genuine sole full-CI capture entry; no focused or shared-cluster substitute. */
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {registerNotificationFinalCatalogueCapture} from './fixtures/notification-worker/final-catalogue-cases';
const file='test/notification-final-catalogue-baseline.test.ts' as const;
admitSingletonTest(file); // Real admission before any capture/fixture SQL.
registerNotificationFinalCatalogueCapture(file);
