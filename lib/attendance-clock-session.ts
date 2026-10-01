import { getSession } from './session';
import { AuthRequiredError } from './auth-errors';
/** API authentication returns 401 rather than turning an absent session into a server error. */
export async function clockApiSession() {
  try { return await getSession(); }
  catch(error) { if(error instanceof AuthRequiredError) return null; throw error; }
}
