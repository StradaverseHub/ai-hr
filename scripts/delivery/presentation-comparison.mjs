/** Compare observed job times. No deployment or release eligibility is inferred. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const time = value => {
  const timestamp = Date.parse(value);
  assert(Number.isFinite(timestamp), 'Invalid Actions timestamp');
  return timestamp;
};
const roundSeconds = milliseconds => Math.round(milliseconds / 1000);
const finished = step => step?.status === 'completed' && step.conclusion === 'success';

export function comparePresentationPilot({shadow, full, plan, fullPlan, staging, negativeControl}) {
  assert(shadow.status === 'completed' && full.status === 'completed', 'Wait for both original runs');
  assert(plan.policy === 'aihr-presentation-shadow/v1' && plan.releaseAuthorized === false);
  assert.equal(plan.candidate, fullPlan.sha, 'Different candidates cannot be compared');
  assert.equal(full.headSha, fullPlan.controller, 'Full run controller differs from plan');
  assert.equal(fullPlan.units.flatMap(unit => unit.kind === 'browser' ? unit.files : []).filter(file => file === plan.journey).length, 3);
  const journey = shadow.jobs.find(job => job.name === 'journey');
  const scopedOutcome = journey.steps.find(step => step.name === 'Verify the selected assertion actually ran');
  const shared = ['build', 'typecheck', 'controller-tests'].map(name => {
    const jobs = full.jobs.filter(job => job.name === name);
    assert.equal(jobs.length, 1, 'Missing or duplicate common job');
    return jobs[0];
  });
  const startFull = time(full.createdAt);
  const startShadow = time(shadow.createdAt);
  const endFull = Math.max(...full.jobs.filter(job => job.conclusion !== 'skipped').map(job => time(job.completedAt)));
  const scopedSeconds = finished(scopedOutcome) ? roundSeconds(time(scopedOutcome.completedAt) - startShadow) : null;
  const commonReadySeconds = shared.every(finished) ? roundSeconds(Math.max(...shared.map(job => time(job.completedAt))) - startFull) : null;
  const failedJobs = full.jobs.filter(job => !['success', 'skipped'].includes(job.conclusion))
    .map(job => ({id: job.databaseId, name: job.name, conclusion: job.conclusion}));
  const referenceBaseMatches = plan.base === fullPlan.migrationBase;
  return {
    kind: 'presentation-shadow-comparison/v1',
    candidate: plan.candidate,
    fullBaseline: fullPlan.migrationBase,
    scopedBaseline: plan.base,
    referenceBaseMatches,
    shadowRun: shadow.url,
    fullRun: full.url,
    fullConclusion: full.conclusion,
    scopedCheckSeconds: scopedSeconds,
    sharedPrerequisiteSeconds: commonReadySeconds,
    // Normalize separate dispatch clocks. This is a CI estimate, not observed release time.
    modeledParallelCiSeconds: referenceBaseMatches && negativeControl && scopedSeconds !== null && commonReadySeconds !== null
      ? Math.max(scopedSeconds, commonReadySeconds) : null,
    shadowWorkflowSeconds: roundSeconds(time(journey.completedAt) - startShadow),
    fullWorkflowSeconds: roundSeconds(endFull - startFull),
    fullCommandRunnerSeconds: full.jobs.filter(job => job.conclusion !== 'skipped')
      .reduce((total, job) => total + Math.max(0, roundSeconds(time(job.completedAt) - time(job.startedAt))), 0),
    fullJobs: full.jobs.length,
    fullPlannedSuiteFiles: fullPlan.suite.length,
    failedJobs,
    negativeControl,
    stagingSnapshot: staging,
    actualStagingWaitSeconds: null,
    actualAcceptedReleaseSeconds: null,
    releaseAuthorized: false,
  };
}

if (process.argv[2]) {
  const sample = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(comparePresentationPilot(sample), null, 2));
}
