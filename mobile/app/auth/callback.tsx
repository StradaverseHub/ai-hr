/**
 * `aihr://auth/callback` — the WorkOS redirect. expo-auth-session normally consumes it inside the auth
 * session and this route never renders; if the OS hands the link to the router instead (e.g. the app
 * was cold-started by it), send the user to the app rather than to an "unmatched route" page.
 */
import { Redirect } from 'expo-router';

export default function AuthCallback() {
  return <Redirect href="/" />;
}
