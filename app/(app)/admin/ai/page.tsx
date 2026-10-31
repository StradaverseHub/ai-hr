import { redirect } from 'next/navigation';

/** Provider setup moved to AI management › Provider, the one place to manage AI. This address forwards
 * there; it reads no session and no data (the destination applies the requireAdmin guard). */
export default function AiConfigRedirect() {
  redirect('/control-tower/agents/provider');
}
