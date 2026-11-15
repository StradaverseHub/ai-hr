import type {ReactNode} from 'react';
import '../lifecycle/v9/workspace.css';
import './automation.css';
/** Shared HR Automation builders (ADR 2026-11-15-probation-shared-automation, decision 1). Each page checks access. */
export default function Layout({children}:{children:ReactNode}){return <div className="v9-workspace automation">{children}</div>;}
