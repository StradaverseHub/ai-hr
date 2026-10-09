import { Redirect } from 'expo-router';

/** AuthSession owns code/state validation; a cold or cancelled callback never grants a session. */
export default function AuthCallback() {
  return <Redirect href="/sign-in" />;
}
