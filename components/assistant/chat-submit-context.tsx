"use client";
import {createContext} from 'react';
export const AssistantChatSubmitContext=createContext<{pending:boolean;clarify:(exchangeId:string,answer:string)=>Promise<void>;setQuestionDraft?:(answer:string)=>void;setClarificationDraft?:(exchangeId:string,answer:string)=>void}|null>(null);
