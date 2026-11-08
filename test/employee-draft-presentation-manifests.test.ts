/** Actual frozen source-identity checks only; no provider approval or call. */
import {expect,it} from 'vitest';
import {admitAiManifests} from '../.github/ci/ai-manifest-admission.mjs';
import {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} from '../lib/ai/provider-data-source-manifest';
import {MODULE_AGENT_SOURCE_DIGEST,MODULE_AGENT_SOURCE_FILE_COUNT} from '../lib/ai/module-agent-source-manifest';

it('checks both generated source identities against the actual clean frozen candidate without renewing disclosure authority',()=>{
 const result=admitAiManifests(process.cwd(),process.env.AIHR_CI_HEAD);
 expect(result.kind).toBe('AI_SOURCE_MANIFEST_ADMISSION');expect(result.releaseAuthorized).toBe(false);
 expect(result.candidate).toBe(process.env.AIHR_CI_HEAD);
 expect(result.checks).toEqual([
  {script:'scripts/ai-provider-data-source-manifest.mjs',files:1486,digest:PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST},
  {script:'scripts/ai-agent-source-manifest.mjs',files:MODULE_AGENT_SOURCE_FILE_COUNT,digest:MODULE_AGENT_SOURCE_DIGEST},
 ]);
// Existing admission has four10s Git calls and two60s checks; this test adds
// no longer child allowance and reserves20s around that existing160s envelope.
},180000);
