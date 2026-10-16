import { useEffect, useRef, useState } from "react";
import { rpc, type BackendInfo } from "./api";
import { Markdown } from "./Markdown";

export type ProjectConfig = { revision: string; primary: string; references: string[]; edit: boolean; commands: boolean; project_id?:string };
type Entry = { name: string; path: string; directory: boolean; size: number };
type FileView = { root: string; path: string; name: string; revision: string; workspace_revision: string; kind: string; text?: string; data?: string; editable: boolean; draft: string; original: string; diff?: string; scroll: number };

export function CodePreview({ text }: { text: string }) {
  const tokens = text.slice(0, 120000).split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b(?:import|from|return|def|class|function|const|let|var|if|else|for|while|async|await|export|try|catch|raise|true|false|null|None|True|False)\b)/g);
  return <pre className="project-code">{tokens.map((part, i) => <span key={i} className={/^['"]/.test(part) ? "code-string" : /^(\/\/|#)/.test(part) ? "code-comment" : /^(import|from|return|def|class|function|const|let|var|if|else|for|while|async|await|export|try|catch|raise|true|false|null|None|True|False)$/.test(part) ? "code-keyword" : undefined}>{part}</span>)}{text.length > 120000 && "\n…预览已截断，编辑与保存仍保留完整文本。"}</pre>;
}

export function ProjectPanel({ info, onQuote, onDirty, folderRequest = 0 }: { folderRequest?: number; onDirty?: (value: boolean) => void; info: BackendInfo | null; onQuote: (text: string) => void }) {
  const [config, setConfig] = useState<ProjectConfig>({ revision: "", primary: "", references: [], edit: false, commands: false });
  const [form, setForm] = useState(config), [configure, setConfigure] = useState(false);
  const [root, setRoot] = useState("main"), [folder, setFolder] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]), [filter, setFilter] = useState("");
  const [files, setFiles] = useState<FileView[]>([]), [active, setActive] = useState("");
  const [mode, setMode] = useState<"read" | "edit" | "diff" | "source">("read");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const current = files.find(f => f.root+":"+f.path === active);
  const alive = useRef(true), generation = useRef(0), filesRef = useRef(files), configRef = useRef(config);
  const [loaded, setLoaded] = useState(false), handledRequest = useRef(0), picking = useRef(false);
  const [contextVersion,setContextVersion]=useState(0),contextProject=useRef<string|undefined>();
  filesRef.current = files; configRef.current = config;
  const reader = useRef<HTMLDivElement>(null), editor = useRef<HTMLTextAreaElement>(null);
  const api = async <T,>(operation: string, args = {}): Promise<T> => {
    if (!info || info.scope === "collaboration") throw new Error("请在桌面客户端管理工作目录与本地文件。");
    const result = await rpc<T & { ok: boolean; error?: string }>(info, "project_workspace", { operation, ...(configRef.current.project_id!==undefined ? {project_id:configRef.current.project_id}:{}), ...args }, { timeoutMs: 120000 });
    if (!result.ok) throw new Error(result.error || "工作区操作失败"); return result;
  };
  useEffect(() => {
    alive.current = true;
    setLoaded(false);
    void api<{ workspace: ProjectConfig }>("load").then(result => { if (alive.current) { setConfig(result.workspace); setForm(result.workspace); setLoaded(true); } }).catch(e => { if (alive.current) setError(String(e)); });
    return () => { alive.current = false; generation.current++; };
  }, [info?.port, info?.token]);
  useEffect(()=>{if(typeof window==='undefined'||!window.addEventListener)return;const changed=(event:Event)=>{const detail=(event as CustomEvent).detail;if(!detail || (detail.project_id===configRef.current.project_id && detail.revision===configRef.current.revision))return;contextProject.current=detail.project_id;setContextVersion(n=>n+1);};window.addEventListener('tebb-project-selected',changed);return()=>window.removeEventListener('tebb-project-selected',changed);},[]);
  const dirty=files.some(f=>f.draft!==f.original);
  useEffect(()=>{if(!contextVersion)return;if(dirty){setNotice('项目已切换，原项目的未保存编辑仍保留；请保存或撤销后继续浏览新项目。');return;}let live=true;const serial=++generation.current;setLoaded(false);setBusy(false);
    void api<{workspace:ProjectConfig}>('load',{project_id:contextProject.current}).then(result=>{if(live&&serial===generation.current){setConfig(result.workspace);setForm(result.workspace);setFiles([]);setActive('');setRoot('main');setFolder('');setLoaded(true);}}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[contextVersion,dirty]);
  useEffect(() => {
    if (loaded && folderRequest > handledRequest.current) { handledRequest.current = folderRequest; void pick(true); }
  }, [loaded, folderRequest]);
  useEffect(() => {
    if (!config.primary && root === "main") { setEntries([]); return; }
    let current = true; const stamp = config.revision;
    void api<{ entries: Entry[]; limited?: boolean }>("tree", { root_id: root, relative: folder }).then(result => { if (current && configRef.current.revision === stamp) { setEntries(result.entries); if (result.limited) setNotice("此目录仅展示前400项，可进入子目录继续浏览。"); } }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [config.revision, root, folder]);
  useEffect(() => { onDirty?.(files.some(f => f.draft !== f.original)); }, [files, onDirty]);
  useEffect(() => { if (reader.current) reader.current.scrollTop = current?.scroll || 0; }, [active, mode]);
  const patch = (value: Partial<FileView>) => setFiles(old => old.map(f => f.root+":"+f.path === active ? { ...f, ...value } : f));
  async function open(entry: Entry) {
    if (entry.directory) { setFolder(entry.path); return; }
    const key = root+":"+entry.path;
    if (filesRef.current.some(f => f.root+":"+f.path === key)) { setActive(key); setMode("read"); return; }
    if (filesRef.current.length>=12) { setNotice("最多同时打开12个项目文件，请先关闭暂时不用的标签。"); return; }
    const serial = ++generation.current; setBusy(true); setError("");
    try {
      const file = await api<Omit<FileView, "draft" | "original" | "scroll">>("read", { root_id: root, relative: entry.path });
      if (!alive.current || serial !== generation.current) return;
      setFiles(old => [...old, { ...file, draft: file.text || "", original: file.text || "", scroll: 0 }]); setActive(key); setMode("read");
    } catch (e) { if (alive.current && serial === generation.current) setError(String(e)); }
    finally { if (alive.current && serial === generation.current) setBusy(false); }
  }
  async function saveFile() {
    if (!current || busy) return; setBusy(true); setError(""); const key = active, content = current.draft;
    try {
      const result = await api<{ revision: string; diff: string }>("write", { relative: current.path, text: content, revision: current.revision, workspace_revision: current.workspace_revision });
      if (alive.current) { setFiles(old => old.map(f => f.root+":"+f.path === key ? { ...f, original: content, revision: result.revision, diff: result.diff } : f)); setNotice("文件已保存。可查看本次差异。"); }
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function reloadFile() {
    if (!current || busy) return;
    const key = active; setBusy(true); setError('');
    try {
      const latest = await api<Omit<FileView,'draft'|'original'|'scroll'>>('read',{root_id:current.root,relative:current.path});
      if (alive.current) {
        const dirty = current.draft!==current.original;
        setFiles(old=>old.map(f=>f.root+':'+f.path===key ? {...f,...latest,original:latest.text || '',draft:dirty ? f.draft : latest.text || ''}:f));
        setMode(dirty?'diff':'read'); setNotice(dirty?'已读取外部最新版本，编辑草稿保留。请在差异中合并后保存。':'已读取文件最新版本。');
      }
    } catch(e) { if(alive.current) setError(String(e)); }
    finally { if(alive.current) setBusy(false); }
  }
  async function saveConfig(value = form, opened = false) {
    if (filesRef.current.some(f => f.draft !== f.original)) { setError("请先保存或撤销打开文件的编辑，再切换工作目录。"); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ workspace: ProjectConfig }>(opened?"open":"save", opened?{primary:value.primary,request_id:crypto.randomUUID().replace(/-/g,'')}:{ primary: value.primary, references: value.references.filter(Boolean), edit: value.edit, commands: value.commands });
      if (alive.current) { generation.current++; setConfig(result.workspace); setForm(result.workspace); setFiles([]); setActive(""); setRoot("main"); setFolder(""); setConfigure(opened); window.dispatchEvent(new CustomEvent("tebb-workspace-changed",{detail:result.workspace})); setNotice(opened ? "文件夹已打开，可直接浏览。需要伙伴修改或验证代码时，请选择下面的权限并保存，再发送任务。" : "工作目录与权限已保存，新任务使用本次配置。"); }
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function pick(openNow = false) {
    if (picking.current || busy) return;
    if (filesRef.current.some(f => f.draft !== f.original)) { setError("请先保存或撤销打开文件的编辑，再切换工作目录。"); return; }
    picking.current = true;
    setBusy(true); setError("");
    try {
      const result = await api<{ paths: string[] }>("pick", { request_id: crypto.randomUUID().replace(/-/g, "") });
      if (alive.current && result.paths?.length) {
        const primary = result.paths[0];
        if (openNow) {
          // A different directory never inherits write or command grants.
          const value = primary === configRef.current.primary ? configRef.current : { ...configRef.current, primary, references: [], edit: false, commands: false };
          await saveConfig(value, true);
        } else setForm(old => ({ ...old, primary, edit: primary === configRef.current.primary && old.edit, commands: primary === configRef.current.primary && old.commands }));
      }
    }
    catch (e) { if (alive.current) setError(String(e)); }
    finally { picking.current = false; if (alive.current) setBusy(false); }
  }
  function quote(selection = false) {
    if (!current) return;
    let content = current.draft;
    if (selection) {
      if (mode === "edit" && editor.current) content = current.draft.slice(editor.current.selectionStart, editor.current.selectionEnd);
      else {
        const selected = window.getSelection?.();
        content = selected && reader.current?.contains(selected.anchorNode) && reader.current?.contains(selected.focusNode) ? selected.toString() : "";
      }
      if (!content) { setNotice("请先在当前文件中选中文字。"); return; }
    }
    onQuote(`文件：${current.root}/${current.path}\n\n${content.slice(0, 3200)}`);
    setNotice(content.length > 3200 ? "已引用前3200字到草稿，完整文件可由获准的伙伴按路径读取。" : "引用已加入草稿，尚未发送。");
  }
  return <section className="project-panel" aria-label="项目文件工作区">
    <header><span title={config.primary}>工作目录 · {config.primary || "尚未打开文件夹"}</span><button disabled={busy || !loaded} onClick={() => void pick(true)}>{config.primary ? "切换文件夹" : "打开文件夹"}</button><button onClick={() => setConfigure(!configure)}>目录与权限</button></header>
    {config.primary && <p role="status">{config.edit ? "允许编辑" : "只读浏览"} · {config.commands ? "允许运行命令" : "未授权命令"}</p>}
    {configure && <form className="project-config" onSubmit={e => { e.preventDefault(); void saveConfig(); }}>
      <p>主目录就是你的项目文件夹，例如 D:\Projects\my-app。打开即可浏览；下面的权限分别决定伙伴能否修改文件、运行测试。</p>
      <label>主目录<div><input aria-label="主目录" value={form.primary} onChange={e => setForm({ ...form, primary: e.target.value, edit: false, commands: false })} placeholder="本机项目文件夹绝对路径" /><button type="button" onClick={() => void pick()} disabled={busy}>选择文件夹</button></div></label>
      <label>只读参考目录（每行一个，最多4个）<textarea rows={2} value={form.references.join("\n")} onChange={e => setForm({ ...form, references: e.target.value.split("\n") })} /></label>
      <label><input type="checkbox" checked={form.edit} onChange={e => setForm({ ...form, edit: e.target.checked })} />允许获准伙伴编辑主目录文件</label>
      <label><input type="checkbox" checked={form.commands} onChange={e => setForm({ ...form, commands: e.target.checked })} />允许本地命令（可修改主目录，WSL 沙箱无网络）</label>
      <button type="submit" disabled={busy}>保存目录与权限</button>
    </form>}
    {!config.primary ? <div className="project-empty"><h3>打开你的项目文件夹</h3><p>像 VS Code 一样，选择文件夹后在左侧浏览文件，点击文件即可预览。文件仍保存在原位置。</p><button disabled={busy || !loaded} onClick={() => void pick(true)}>选择并打开文件夹</button><p>只想让伙伴写一段代码或解释算法？直接发消息即可，不必打开文件夹。</p></div> : <div className="project-body"><aside className="project-tree"><select aria-label="文件根目录" value={root} onChange={e => { setRoot(e.target.value); setFolder(""); }}><option value="main">主目录</option>{config.references.map((p,i) => <option key={i} value={`ref-${i}`}>只读 · {p.split(/[\\/]/).pop()}</option>)}</select>
      <div><button disabled={!folder} onClick={() => setFolder(folder.split("/").slice(0,-1).join("/"))}>↑ 上级</button><button onClick={() => setFolder("")}>根目录</button><button onClick={() => { setConfig(c => ({ ...c, revision: c.revision })); void api<{ entries: Entry[] }>("tree", { root_id: root, relative: folder }).then(r => setEntries(r.entries)).catch(e => setError(String(e))); }}>刷新</button></div>
      <small>{folder || "/"}</small><input aria-label="筛选当前目录" placeholder="筛选当前目录" value={filter} onChange={e => setFilter(e.target.value)} />
      {entries.filter(e => e.name.toLowerCase().includes(filter.toLowerCase())).map(e => <button className="project-tree-entry" key={e.path} onClick={() => void open(e)}>{e.directory ? "▸" : "·"} {e.name}</button>)}
    </aside><div className="project-file"><nav className="project-tabs" aria-label="已打开项目文件">{files.map(f => <span key={f.root+":"+f.path}><button aria-pressed={active === f.root+":"+f.path} onClick={() => { setActive(f.root+":"+f.path); setMode("read"); }}>{f.name}{f.draft !== f.original ? " *" : ""}</button><button aria-label={`关闭文件 ${f.name}`} onClick={() => { if (f.draft!==f.original) { setNotice('请先保存或撤销此文件的修改。'); return; } const remaining=files.filter(item => item!==f); setFiles(remaining); if(active===f.root+':'+f.path) setActive(remaining[0] ? remaining[0].root+':'+remaining[0].path : ''); }}>×</button></span>)}</nav>
      {current ? <><div className="project-file-actions"><span>{current.root}/{current.path} · {current.editable ? "可编辑" : "只读"}</span><button aria-pressed={mode === "read"} onClick={() => setMode("read")}>预览</button><button onClick={() => setMode("source")}>源码</button>{current.editable && <button aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>编辑</button>}<button disabled={busy} onClick={() => void reloadFile()}>读取最新版本</button><button aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>差异</button>{current.editable && <button disabled={busy || current.draft === current.original} onClick={() => void saveFile()}>保存</button>}</div>
      <div className="project-reader" ref={reader} onScroll={e => patch({ scroll: e.currentTarget.scrollTop })}>{current.kind === "image" ? <img alt={current.name} src={current.data} /> : mode === "edit" ? <textarea ref={editor} aria-label="文件编辑内容" spellCheck={false} value={current.draft} onChange={e => patch({ draft: e.target.value })} /> : mode === "diff" ? <><p>保存前原文／当前草稿；保存后显示本次实际差异。</p>{current.draft !== current.original ? <div className="project-diff"><CodePreview text={current.original} /><CodePreview text={current.draft} /></div> : <CodePreview text={current.diff || "暂无修改差异"} />}</> : mode === "read" && /\.(md|markdown)$/i.test(current.name) ? <Markdown text={current.draft} /> : <CodePreview text={current.draft} />}</div>
      {current.kind === "text" && <footer><button onMouseDown={e => e.preventDefault()} onClick={() => quote(true)}>引用选中文字</button><button onClick={() => quote()}>引用文件到草稿</button>{current.draft !== current.original && <button onClick={() => patch({ draft: current.original })}>撤销未保存修改</button>}</footer>}</> : <p className="project-empty">从左侧目录选择文件预览。聊天草稿会保留。</p>}
    </div></div>}
    {busy && <p role="status">正在处理…</p>}{error && <p role="alert" className="cp-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
