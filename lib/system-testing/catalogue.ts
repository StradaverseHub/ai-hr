/** Reviewed build-bundled instructions. No remote URLs, runtime Git or generated tenant information. */
import raw from './catalogue.json';
import { catalogueSchema } from './model';
export const REVIEWED_SYSTEM_TESTING_CATALOGUE = catalogueSchema.parse(raw);
