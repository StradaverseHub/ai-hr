/** Build/configuration leaf only. Verification never invokes Git or runs in an application request. */
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants';
import {
  assertTestingBuildNotObserved, emptySystemTestingCompileEnvironment, readPublishedTestingBuild,
  systemTestingBuildDirectory, systemTestingCompileEnvironment, verifyInstalledTestingBuild,
} from './system-testing-manifest';

/** Inherited metadata alone never authorizes compilation, including direct `next build`. */
export function systemTestingNextCompileEnvironment(p: {
  phase: string; worktree: string; environment?: Readonly<Record<string, string | undefined>>;
}): Record<string, string> {
  // Production startup and other phases do no source/private-record filesystem reads.
  if (p.phase !== PHASE_PRODUCTION_BUILD && p.phase !== PHASE_DEVELOPMENT_SERVER) return emptySystemTestingCompileEnvironment();
  const environment = p.environment ?? process.env, context = environment.AIHR_SYSTEM_TESTING_BUILD_CONTEXT;
  if (!context) return emptySystemTestingCompileEnvironment();
  const required = p.phase === PHASE_PRODUCTION_BUILD ? 'official' : 'dev_only';
  if (context !== required) throw new Error('System Testing build context does not match the Next phase.');
  const selected = readPublishedTestingBuild(systemTestingBuildDirectory(context === 'official' ? 'remote' : 'local'), {
    sourceRef: environment.AIHR_SYSTEM_TESTING_SOURCE_REF ?? '',
    buildRecordId: environment.AIHR_SYSTEM_TESTING_BUILD_RECORD_ID ?? '',
  });
  assertTestingBuildNotObserved(selected.buildDirectory);
  // Derive all five values from validated owned bytes, never the inherited JSON or hashes.
  return systemTestingCompileEnvironment(verifyInstalledTestingBuild(selected.record, p.worktree));
}
