import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isLifecycleV9Path } from '../lib/lifecycle-v9-routing';
it('keeps native V9 case pages in the same shell while retaining the boundary for other workspaces', () => {
  for (const path of ['/lifecycle/v9', '/lifecycle/v9/', '/lifecycle/v9/onboarding/native-case']) expect(isLifecycleV9Path(path)).toBe(true);
  for (const path of [null, undefined, '', '/lifecycle/v90', '/lifecycle/onboarding/cases/native-case', '/me/lifecycle']) expect(isLifecycleV9Path(path)).toBe(false);
  for (const file of ['app/layout.tsx', 'app/providers.tsx']) expect(readFileSync(file, 'utf8')).toContain('isLifecycleV9Path(pathname)');
});
