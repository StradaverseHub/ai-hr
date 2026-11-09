import { createContext, type RefObject } from 'react';

/** The signed-out gate holds this across a brief app switch, in memory only. */
export const MfaResumeContext = createContext<RefObject<{ owner: number; challenge: string } | null> | null>(null);
