'use client';

import * as React from 'react';

/** Employee Today: one panel's error boundary. A panel that throws while it renders (or whose stream fails) is replaced
 * by its own quiet "could not load" note; the rest of the page keeps working. Every panel also sits in its own Suspense
 * boundary (components/today/employee/today-page.tsx), and catches its own read failures before it renders. */
export class PanelBoundary extends React.Component<{children:React.ReactNode;fallback:React.ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?this.props.fallback:this.props.children;}
}
