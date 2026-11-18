/** Catalogues of the modules that run on the shared builders. A module is absent until it moves (ADR decision 2). */
import type {AutomationModule,AutomationModuleCatalogue} from '../catalogue';
import {PROBATION_AUTOMATION_CATALOGUE} from './probation';
import {OFFBOARDING_AUTOMATION_CATALOGUE} from './offboarding';
export const AUTOMATION_CATALOGUES:Partial<Record<AutomationModule,AutomationModuleCatalogue>>={probation:PROBATION_AUTOMATION_CATALOGUE,off:OFFBOARDING_AUTOMATION_CATALOGUE};
export function automationCatalogue(module:AutomationModule):AutomationModuleCatalogue|null{return AUTOMATION_CATALOGUES[module]??null;}
