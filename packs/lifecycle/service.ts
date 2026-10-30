/**
 * Lifecycle service facade (ADR-0080 D11, ADR-0095). The ONE module outside-the-pack callers import for
 * lifecycle services. Server-only in practice (drags in db/client).
 */
export { LifecycleError, LEVEL } from '../../core/lifecycle-base';
export * from '../../core/lifecycle-config';
export * from '../../core/lifecycle-cases';
export * from '../../core/lifecycle-it';
export * from '../../core/lifecycle-assets';
export * from '../../core/lifecycle-self';
export * from '../../core/lifecycle-import';
export * from '../../core/lifecycle-worklist';
export * from '../../core/lifecycle-export';
export * from '../../core/lifecycle-rules';
export * from '../../core/lifecycle-defaults';

export * from './onboarding/service';
export * from './v9/entrypoints';
export type { Workspace as LifecycleV9Workspace, Command as LifecycleV9Command, OwnCase as LifecycleV9OwnCase, CaseDetail as LifecycleV9CaseDetail, UpdatedEmailPreview as LifecycleV9UpdatedEmailPreview } from './v9/service';
