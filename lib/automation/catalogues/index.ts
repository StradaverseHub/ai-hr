/** Catalogues of the modules that run on the shared builders. A module is absent until it moves (ADR decision 2). */
import type {AutomationModule,AutomationModuleCatalogue} from '../catalogue';
import {PROBATION_AUTOMATION_CATALOGUE} from './probation';
export const AUTOMATION_CATALOGUES:Partial<Record<AutomationModule,AutomationModuleCatalogue>>={probation:PROBATION_AUTOMATION_CATALOGUE};
export function automationCatalogue(module:AutomationModule):AutomationModuleCatalogue|null{return AUTOMATION_CATALOGUES[module]??null;}
