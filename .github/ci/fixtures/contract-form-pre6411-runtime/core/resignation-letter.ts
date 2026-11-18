/** Server bindings for the Offboarding-only adapter over the shared content-bound signing model. */
import {createHash, randomUUID} from 'node:crypto';
import * as letter from '../lib/resignation-letter';
const dependencies: letter.ResignationLetterDependencies = {
  fingerprint: content => createHash('sha256').update(content).digest('hex'), newId: randomUUID,
};
export const generateResignationLetter = (input: letter.GenerateResignationLetterInput) => letter.generateResignationLetter(input, dependencies);
export const regenerateResignationLetter = (document: letter.ResignationLetter, input: Parameters<typeof letter.regenerateResignationLetter>[1]) => letter.regenerateResignationLetter(document, input, dependencies);
export const actResignationLetter = (document: letter.ResignationLetter, input: letter.ActResignationLetterInput) => letter.actResignationLetter(document, input, dependencies);
export const reconcileResignationLetter = (document: letter.ResignationLetter, values: Record<string, string>) => letter.reconcileResignationLetter(document, values, dependencies);
export {lapseResignationLetter, resignationLetterCapabilities, resignationLetterPreview, resignationLetterPendingSteps, resignationLetterEmployeePending, resignationLetterCorrection} from '../lib/resignation-letter';
export type {ResignationLetter, ResignationLetterResult, ResignationLetterActor, ResignationLetterAction, ResignationLetterTemplate, GenerateResignationLetterInput, ResignationLetterEvent} from '../lib/resignation-letter';
