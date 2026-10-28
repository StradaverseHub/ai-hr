/** TEMPORARY reminder-owner journeys with exact disposable draft SQL; remove after journal allocation. */
import {beforeAll} from 'vitest';
import {rehearseEmailDesignDraft} from './email-design-draft-rehearsal-fixture';
import './onehr-service-moderation-reminders.test';
beforeAll(rehearseEmailDesignDraft);
