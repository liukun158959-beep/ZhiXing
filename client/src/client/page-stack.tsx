import { createContext, useContext, useRef, type ReactNode } from 'react';

const PageActive = createContext(true);
export function usePageActive() { return useContext(PageActive); }

// Keep visited pages and their inputs/scroll positions. Hidden pages pause polling.
export function PageStack({ active, children }: { active: string; children: ReactNode }) {
  const pages = useRef(new Map<string, ReactNode>());
  if (active) pages.current.set(active, children);
  return <>{[...pages.current].map(([key, content]) => <PageActive.Provider key={key} value={key === active}>
    <div className="tebb-page-panel" data-page-panel={key} hidden={key !== active} style={{ display: key === active ? 'flex' : 'none' }}>{content}</div>
  </PageActive.Provider>)}</>;
}
