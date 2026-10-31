import {afterAll,beforeAll,it} from 'vitest';
import {closeAll,migrateTestDb} from './harness';
import {runClaimsLoad} from './fixtures/claims-load';
beforeAll(migrateTestDb);afterAll(closeAll);
it('measures burst and paced journeys for 500 employee sessions over one million distributed claims',()=>runClaimsLoad(),240000);
