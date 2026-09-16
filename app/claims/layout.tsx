import { moduleLayout } from '@/lib/module-layout';

// Route-segment guard for the claims module (r292). The CONTROL is the service gate in
// core/module-gate.ts; this is the courtesy redirect to /?moduleUnavailable=claims.
// See lib/module-layout.tsx for exactly what a layout does and does not cover.
export default moduleLayout('claims');
