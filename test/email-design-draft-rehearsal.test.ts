/** TEMPORARY disposable CI rehearsal; remove when the exact migration is allocated/journaled. */
import {beforeAll} from 'vitest';
import {rehearseEmailDesignDraft} from './email-design-draft-rehearsal-fixture';
import './email-design-storage.test';
beforeAll(rehearseEmailDesignDraft);
