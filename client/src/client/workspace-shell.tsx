import { useRef, type ReactNode } from "react";
import { CURRENT_RELEASE } from "./release";
import { versionTap } from "./top-toolbar";

export function ProductBrand({ developer, onToggle }: { developer: boolean; onToggle: () => void }) {
  const taps = useRef({ count: 0, time: 0 });
  return <div className="tebb-product-brand"><span>tebb<span>.</span></span><button type="button" data-product-version aria-label={`版本 v${CURRENT_RELEASE.version}，连续点击五次切换开发者模式`} title="连续点击五次切换开发者模式" aria-pressed={developer} onClick={() => { const next = versionTap(taps.current, Date.now()); taps.current = next; if (next.open) onToggle(); }}>v{CURRENT_RELEASE.version}</button><small role="status">{developer ? "DEV MODE" : "WORKSPACE"}</small></div>;
}
export function WorkspaceRail({ children, developer, onToggle }: { children: ReactNode; developer: boolean; onToggle: () => void }) {
  return <aside className="tebb-global-rail" aria-label="全局导航"><ProductBrand developer={developer} onToggle={onToggle} /><nav aria-label="工作区快捷栏">{children}</nav></aside>;
}
