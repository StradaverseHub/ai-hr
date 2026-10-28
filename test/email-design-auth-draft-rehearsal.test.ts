/** TEMPORARY real account/recovery journeys over disposable unallocated draft SQL, never a release gate. */
import {beforeAll} from 'vitest';
import {rehearseEmailDesignDraft} from './email-design-draft-rehearsal-fixture';
import './internal-auth.test';
beforeAll(rehearseEmailDesignDraft);
