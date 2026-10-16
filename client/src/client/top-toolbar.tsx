
export function versionTap(previous: { count: number; time: number }, now: number) {
  const count = now - previous.time > 3000 ? 1 : previous.count + 1;
  return { count: count >= 5 ? 0 : count, time: now, open: count >= 5 };
}

export function TopToolbar({ title, model, connected, busy, dark, onTheme, onNewChat, onMonitor, onVideo, onDebug, onFile, onFolder, onTerminal, sidebarOpen, sidebarAvailable, onSidebarToggle }: {
  title: string; model: string; connected: boolean; busy: boolean; dark: boolean;
  onTheme: () => void; onNewChat: () => void; onMonitor: () => void; onVideo: () => void; onDebug: () => void;
  onFile?: () => void; onFolder?: () => void; onTerminal?: () => void;
  sidebarOpen?: boolean; sidebarAvailable?: boolean; onSidebarToggle?: () => void;
}) {
  return <header data-top-toolbar className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-card/85 px-4 py-1">
    <div className="flex min-w-0 items-center gap-3"><span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
      <span className="text-sm font-medium">{title}</span><span className="hidden max-w-64 truncate text-xs text-muted-foreground xl:block" title={model}>{model || "未选择模型"}</span>
      <span className="text-xs text-muted-foreground">{connected ? "已连接" : "连接中"}{busy ? " · 执行中" : ""}</span>
    </div>
    <nav aria-label="顶部工具栏" className="flex items-center gap-1 text-xs">
      {onSidebarToggle && <button className="desk-menu-item" disabled={!sidebarAvailable} aria-expanded={!!sidebarOpen} aria-label={sidebarOpen ? '收起侧栏' : '打开侧栏'} onClick={onSidebarToggle}>{sidebarOpen ? '收起侧栏' : '打开侧栏'}</button>}
      <button className="desk-menu-item" onClick={onNewChat}>新对话</button>
      <button className="desk-menu-item" onClick={onMonitor}>任务</button>
      <button className="desk-menu-item" onClick={onVideo}>视频</button>
      <button className="desk-menu-item" disabled={!connected} onClick={onTerminal}>终端</button>
      <button className="desk-menu-item" disabled={!connected} onClick={onFile}>文件</button>
      <button className="desk-menu-item" disabled={!connected} onClick={onFolder}>文件夹</button>
      <button className="desk-menu-item" aria-label="切换主题" onClick={onTheme}>{dark ? "浅色" : "深色"}</button>

    </nav>
  </header>;
}
