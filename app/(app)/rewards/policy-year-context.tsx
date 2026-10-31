'use client';
import {createContext,useContext} from 'react';
export const RewardPolicyYearContext=createContext<number|null>(null);
export function useRewardPolicyYear(fallback:number){return useContext(RewardPolicyYearContext)??fallback;}
