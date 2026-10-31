import { MobileSetupLink } from './setup-link';

/** Public connection handoff only; the signed setup lives in the fragment, never the request. */
export default function MobileSetupPage() {
  return <MobileSetupLink />;
}
