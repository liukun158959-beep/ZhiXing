import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { DEMO_STORAGE, RUN_LABELS, STEP_LABELS, demoReducer, initialDemo, restoreDemo, runActive,
  type DemoAgent, type DemoAction, type DemoRun } from "./chat-prototype-state";
import { startupReady } from "./startup";
import "./chat-prototype.css";

function Avatar({ agent, group = false }: { agent?: DemoAgent; group?: boolean }) {
  return <span className={`cp-avatar ${group ? "cp-group-avatar" : `cp-${agent?.tone || "gold"}`}`} aria-hidden="true">{group ? "#" : agent?.mark || "t"}</span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
    return () => prior?.focus?.();
  }, []);
  return <div className="cp-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="cp-modal" ref={box} role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const items = Array.from(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || []);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}><header><div><span className="cp-eyebrow">TEBB / LOCAL PREVIEW</span><h2>{title}</h2></div><button className="cp-icon-button" onClick={onClose} aria-label="关闭弹窗">×</button></header>{children}</div>
  </div>;
}

function AgentForm({ agent, agents, onSave, onClose }: { agent: DemoAgent; agents: DemoAgent[]; onSave: (agent: DemoAgent) => void; onClose: () => void }) {
  const [form, setForm] = useState(agent);
  const [error, setError] = useState("");
  return <Modal title={agent.id ? `${agent.name} 的设置` : "创建 Agent"} onClose={onClose}>
    <form className="cp-form" onSubmit={event => {
      event.preventDefault();
      if (!form.name.trim() || /[\s@]/.test(form.name.trim()) || agents.some(a => a.id !== form.id && a.name === form.name.trim())) { setError("名称不能为空、重复，或包含空格和 @。"); return; }
      onSave(form);
    }}>
      <p className="cp-muted">配置仅用于原型演示。请勿填写密钥或真实隐私信息。</p>
      <label>名称<input value={form.name} maxLength={24} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>职责<textarea rows={2} value={form.role} maxLength={160} onChange={event => setForm({ ...form, role: event.target.value })} /></label>
      <label>模型标记<input value={form.model} maxLength={80} onChange={event => setForm({ ...form, model: event.target.value })} /><small>用于体验配置位置，尚未绑定真实模型。</small></label>
      <fieldset><legend>允许使用的工具 · 演示配置</legend><div className="cp-checks">{["联网搜索", "文件", "终端", "飞书"].map(tool => <label key={tool}><input type="checkbox" checked={form.tools.includes(tool)}
        onChange={event => setForm({ ...form, tools: event.target.checked ? [...form.tools, tool] : form.tools.filter(item => item !== tool) })} />{tool}</label>)}</div></fieldset>
      <label>Agent 私有记忆<textarea rows={3} value={form.memory} maxLength={2000} onChange={event => setForm({ ...form, memory: event.target.value })} /><small>这段演示记忆仅在该 Agent 的设置中展示，不自动加入群消息。</small></label>
      {error && <p role="alert" className="cp-error">{error}</p>}
      <footer><button type="button" className="cp-button" onClick={onClose}>取消</button><button className="cp-button cp-primary" type="submit">保存原型配置</button></footer>
    </form>
  </Modal>;
}

function GroupForm({ agents, onCreate, onClose }: { agents: DemoAgent[]; onCreate: (title: string, members: string[], goal: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [members, setMembers] = useState(agents.map(agent => agent.id));
  return <Modal title="新建协作群" onClose={onClose}><form className="cp-form" onSubmit={event => { event.preventDefault(); if (title.trim() && members.length >= 2) onCreate(title, members, goal); }}>
    <label>群名称<input value={title} maxLength={40} placeholder="例如：开源项目观察" onChange={event => setTitle(event.target.value)} required /></label>
    <label>共同目标<textarea rows={2} value={goal} maxLength={500} placeholder="这个群要一起完成什么？" onChange={event => setGoal(event.target.value)} /></label>
    <fieldset><legend>邀请 Agent · 至少两位</legend><div className="cp-member-options">{agents.map(agent => <label key={agent.id}><input type="checkbox" checked={members.includes(agent.id)}
      onChange={event => setMembers(event.target.checked ? [...members, agent.id] : members.filter(id => id !== agent.id))} /><Avatar agent={agent} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span></label>)}</div></fieldset>
    <p className="cp-muted">你是群里唯一的真人。tebb 在场时担任协调者，否则由第一位入选的 Agent 协调。</p>
    <footer><button type="button" className="cp-button" onClick={onClose}>取消</button><button className="cp-button cp-primary" type="submit" disabled={!title.trim() || members.length < 2}>创建协作群</button></footer>
  </form></Modal>;
}

export function ChatPrototype({ standalone = false }: { standalone?: boolean }) {
  const [state, dispatch] = useReducer(demoReducer, undefined, () => {
    try { return restoreDemo(localStorage.getItem(DEMO_STORAGE)); } catch { return initialDemo(); }
  });
  const [storageError, setStorageError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"message" | "task">("message");
  const [target, setTarget] = useState("");
  const [updateRun, setUpdateRun] = useState("");
  const [focusedRun, setFocusedRun] = useState("");
  const [automatic, setAutomatic] = useState(false);
  const [tab, setTab] = useState<"tasks" | "members" | "inbox">("tasks");
  const [inspector, setInspector] = useState(true);
  const [mobileList, setMobileList] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<DemoAgent | null>(null);
  const [artifactId, setArtifactId] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const conversation = state.conversations.find(item => item.id === state.selected)!;
  const members = state.agents.filter(agent => conversation.members.includes(agent.id));
  const messages = state.messages.filter(message => message.conversation === conversation.id);
  const runs = state.runs.filter(run => run.conversation === conversation.id);
  const active = state.runs.filter(runActive);
  const pending = state.requests.filter(request => request.state === "pending");
  const selectedRun = runs.find(run => run.id === updateRun);
  const currentArtifact = state.runs.find(run => run.id === artifactId);
  const draft = drafts[conversation.id] || "";
  const setDraft = (text: string) => setDrafts(previous => ({ ...previous, [conversation.id]: text }));
  const member = (id: string) => state.agents.find(agent => agent.id === id);

  useEffect(() => {
    try { localStorage.setItem(DEMO_STORAGE, JSON.stringify(state)); setStorageError(""); }
    catch { setStorageError("原型状态未能保存，刷新后可能丢失。可继续体验。原型中不要填写敏感资料。"); }
  }, [state]);
  useEffect(() => { if (standalone) startupReady(); }, [standalone]);
  useEffect(() => {
    if (!automatic) return;
    const timer = window.setInterval(() => dispatch({ type: "advance" }), 3500);
    return () => window.clearInterval(timer);
  }, [automatic]);
  useEffect(() => { if (!active.length) setAutomatic(false); }, [active.length]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [state.selected, messages.length]);
  useEffect(() => { if (tab === "tasks" && inspector && focusedRun) document.getElementById(`cp-run-${focusedRun}`)?.scrollIntoView?.({ block: "nearest" }); }, [focusedRun, tab, inspector]);

  function select(id: string) {
    dispatch({ type: "select", id }); setTarget(""); setUpdateRun(""); setFocusedRun(""); setMobileList(false);
  }
  function supplement(run: DemoRun) {
    select(run.conversation); setUpdateRun(run.id); setFocusedRun(run.id); setInspector(true); setTab("tasks");
    input.current?.focus();
  }
  function submit() {
    if (!draft.trim()) return;
    const action: DemoAction = { type: "send", text: draft, target, mode, run: updateRun || undefined };
    const next = demoReducer(state, action);
    dispatch(action);
    if (next.notice) return;
    setDraft(""); setUpdateRun("");
    if (mode === "task" || updateRun) { setInspector(true); setTab("tasks"); }
  }
  function addAgent() {
    setEditingAgent({ id: "", name: "", role: "", mark: "A", tone: "sage", model: "自定义模型 · 演示", tools: [], memory: "" });
  }
  function runCard(run: DemoRun) {
    const owner = member(run.agent)!;
    return <article key={run.id} id={`cp-run-${run.id}`} className={`cp-task ${focusedRun === run.id ? "cp-task-focused" : ""}`} data-demo-run={run.id}>
      <div className="cp-task-meta"><span className={`cp-state cp-state-${run.state}`}><i />{RUN_LABELS[run.state]}</span><span>{owner.name}</span></div>
      <h3>{run.title}</h3>
      <div className="cp-progress" aria-label={`演示进度 ${Math.min(100, Math.round(run.step / 3 * 100))}%`}><span style={{ width: `${run.step / 3 * 100}%` }} /></div>
      <p className="cp-task-step">{run.state === "waiting" ? "前序成果就绪后接续执行" : run.state === "cancelled" ? "进度已保留" : run.state === "succeeded" ? "成果结构样例已就绪" : STEP_LABELS[Math.min(run.step, 2)]}</p>
      {!!run.updates.length && <p className="cp-update-receipt">补充 {run.updates.length} 条 · 已应用 {run.applied} 条{run.applied < run.updates.length && runActive(run) ? " · 等待下一步" : ""}</p>}
      <div className="cp-task-actions">{runActive(run) ? <><button onClick={() => supplement(run)}>补充要求</button><button onClick={() => dispatch({ type: "cancel", id: run.id })}>停止</button></> :
        run.artifact ? <button onClick={() => setArtifactId(run.id)}>查看成果 ↗</button> : <span className="cp-muted">未生成成果</span>}</div>
      <details><summary>执行记录 · {run.events.length}</summary><ol>{run.events.map((event, index) => <li key={index}>{event}</li>)}</ol></details>
    </article>;
  }

  return <section className={`cp-root ${standalone ? "cp-standalone" : "cp-embedded"}`} aria-label="协作聊天原型" data-chat-prototype>
    <div className="cp-preview-strip"><span><b>交互原型</b> 本地模拟 · 不调用模型或外部工具</span><span className="cp-preview-actions">
      {standalone && <button onClick={() => { const next = !dark; setDark(next); document.documentElement.classList.toggle("dark", next); document.documentElement.classList.toggle("light", !next); }} aria-label="切换原型主题">{dark ? "浅色" : "深色"}</button>}
      <button onClick={() => setResetOpen(true)}>重置演示</button></span></div>
    <div className="cp-layout">
      <aside className={`cp-conversations ${mobileList ? "cp-list-open" : ""}`} aria-label="原型会话列表">
        <div className="cp-brand"><span>tebb<span className="cp-brand-dot">.</span></span><small>YOUR AGENT CIRCLE</small></div>
        <div className="cp-list-heading"><span>协作空间</span><button className="cp-icon-button" aria-label="新建协作群" onClick={() => setGroupOpen(true)}>＋</button></div>
        {state.conversations.filter(c => c.kind === "group").map(item => <button key={item.id} className={`cp-conversation ${item.id === state.selected ? "is-selected" : ""}`} aria-pressed={item.id === state.selected} onClick={() => select(item.id)}>
          <Avatar group /><span><strong>{item.title}</strong><small>你 ＋ {item.members.length} 位 Agent</small></span>{state.runs.some(run => run.conversation === item.id && runActive(run)) && <i className="cp-live-dot" />}</button>)}
        <div className="cp-list-heading cp-list-gap"><span>你的 Agent</span><button className="cp-icon-button" aria-label="创建 Agent" onClick={addAgent}>＋</button></div>
        {state.conversations.filter(c => c.kind === "dm").map(item => { const agent = member(item.coordinator)!; return <button key={item.id} className={`cp-conversation ${item.id === state.selected ? "is-selected" : ""}`} aria-pressed={item.id === state.selected} onClick={() => select(item.id)}>
          <Avatar agent={agent} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span>{state.runs.some(run => run.conversation === item.id && runActive(run)) && <i className="cp-live-dot" />}</button>; })}
        <div className="cp-list-bottom"><button className="cp-inbox-link" onClick={() => { setInspector(true); setTab("inbox"); setMobileList(false); }}><span>◇ 待你处理</span><b>{pending.length}</b></button>
          <div className="cp-profile"><span className="cp-user-avatar">你</span><span><strong>我的工作空间</strong><small>本地预览 · 未消耗模型额度</small></span></div></div>
      </aside>

      <div className="cp-chat">
        <header className="cp-chat-header"><div className="cp-chat-title"><button className="cp-icon-button cp-mobile-menu" aria-label="切换会话列表" aria-expanded={mobileList} onClick={() => setMobileList(!mobileList)}>☰</button><Avatar group={conversation.kind === "group"} agent={member(conversation.coordinator)} />
          <div><h1>{conversation.title}</h1><span>{conversation.kind === "group" ? `你与 ${members.length} 位 Agent · ${member(conversation.coordinator)?.name} 协调` : member(conversation.coordinator)?.role}</span></div></div>
          <button className="cp-button cp-context-toggle" onClick={() => setInspector(!inspector)} aria-expanded={inspector}>{inspector ? "收起详情" : "任务与成员"}</button></header>
        <div className="cp-goal"><span>共同目标</span><p>{conversation.goal || "为这个群确定一个目标，开始协作。"}</p></div>
        <div className="cp-message-list" aria-label="原型聊天记录">
          <div className="cp-date-line"><span>一个持续协作的空间</span></div>
          {!messages.length && <div className="cp-empty-chat"><Avatar agent={member(conversation.coordinator)} /><h2>从一句话开始</h2><p>直接聊天，或者将目标交给 Agent。<br />私聊与协作群分别保留各自的消息。</p><button className="cp-button" onClick={() => { setDraft("帮我整理这周的研究方向"); setMode("task"); input.current?.focus(); }}>试试交给 Agent ↗</button></div>}
          {messages.map(item => item.kind === "notice" ? <p key={item.id} className="cp-system-message">{item.text}</p> : <article key={item.id} className={`cp-message ${item.sender === "user" ? "cp-message-user" : ""}`}>
            {item.sender === "user" ? <span className="cp-user-avatar">你</span> : <Avatar agent={member(item.sender)} />}
            <div className="cp-message-content"><div className="cp-message-author"><strong>{item.sender === "user" ? "你" : member(item.sender)?.name}</strong><span>{item.sender === "user" ? "" : "AGENT"}</span>{item.kind === "result" && <span className="cp-result-tag">成果</span>}</div>
              <p>{item.text}</p>{item.run && <button className="cp-message-reference" onClick={() => { setFocusedRun(item.run!); setInspector(true); setTab("tasks"); }}>↗ 关联任务</button>}
              {item.kind === "result" && runs.find(run => run.id === item.run)?.artifact && <button className="cp-artifact-link" onClick={() => setArtifactId(item.run!)}><span>▤</span><span><strong>成果文档 · 演示</strong><small>打开阅读，查看交付确认</small></span><span>↗</span></button>}
            </div></article>)}
          <div ref={end} />
        </div>
        <div className="cp-compose-area">
          <div className="cp-live-bar"><span><i className={active.length ? "cp-live-dot" : "cp-idle-dot"} />{active.length ? `${active.length} 项后台演示 · ${automatic ? "自动推进中" : "已暂停，可逐步查看"}` : "没有进行中的后台演示"}</span>
            <div><button disabled={!active.length} onClick={() => setAutomatic(!automatic)}>{automatic ? "暂停" : "自动演示"}</button><button disabled={!active.length} onClick={() => dispatch({ type: "advance" })}>推进一步 →</button></div></div>
          {selectedRun && <div className="cp-reply-context"><span>补充给：<strong>{selectedRun.title}</strong>{!runActive(selectedRun) && " · 已结束，请取消引用"}</span><button aria-label="取消补充要求" onClick={() => setUpdateRun("")}>×</button></div>}
          <form className="cp-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
            <textarea ref={input} value={draft} maxLength={4000} aria-label="原型消息" rows={2} placeholder={updateRun ? "补充这项任务的要求…" : "和 Agent 聊聊，或 @ 一位成员…"}
              onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(); } }} />
            <div className="cp-composer-bottom"><div className="cp-composer-controls"><label><span>发送给</span><select aria-label="发送给" value={target} disabled={!!updateRun} onChange={event => setTarget(event.target.value)}>
              <option value="">{conversation.kind === "group" ? "群协调者" : member(conversation.coordinator)?.name}</option>{members.filter(agent => agent.id !== conversation.coordinator).map(agent => <option key={agent.id} value={agent.id}>@{agent.name}</option>)}</select></label>
              {!updateRun && <div className="cp-mode" role="group" aria-label="消息类型"><button type="button" aria-pressed={mode === "message"} onClick={() => setMode("message")}>发消息</button><button type="button" aria-pressed={mode === "task"} onClick={() => setMode("task")}>交给 Agent</button></div>}</div>
              <button type="submit" className="cp-send" disabled={!draft.trim() || (!!selectedRun && !runActive(selectedRun))}>{updateRun ? "提交补充" : mode === "task" ? "创建演示任务" : "发送"}<span>↑</span></button></div>
          </form>
          <div className="cp-composer-hint"><span>Enter 发送 · Shift + Enter 换行</span><span>演示数据仅存于此设备</span></div>
          {(state.notice || storageError) && <p className="cp-notice" role="status">{storageError || state.notice}</p>}
        </div>
      </div>

      {inspector && <aside className="cp-inspector" aria-label="协作详情"><header><span>工作台</span><button className="cp-icon-button cp-inspector-close" onClick={() => setInspector(false)} aria-label="关闭协作详情">×</button></header>
        <div className="cp-tabs" role="tablist" aria-label="协作详情分类">{([['tasks', '任务'], ['members', '成员'], ['inbox', `待办${pending.length ? ` ${pending.length}` : ""}`]] as const).map(([key, title]) =>
          <button key={key} role="tab" id={`cp-tab-${key}`} aria-selected={tab === key} aria-controls="cp-detail-panel" tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); const keys = ["tasks", "members", "inbox"] as const;
            const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (keys.indexOf(tab) + (event.key === "ArrowRight" ? 1 : 2)) % 3;
            setTab(keys[next]); document.getElementById(`cp-tab-${keys[next]}`)?.focus();
          }}>{title}</button>)}</div>
        <div className="cp-inspector-body" id="cp-detail-panel" role="tabpanel" aria-labelledby={`cp-tab-${tab}`}>
          {tab === "tasks" ? <><div className="cp-section-heading"><span>当前会话</span><span>{runs.filter(runActive).length} 项进行中</span></div>{runs.map(run => runCard(run))}
            {!runs.length && <div className="cp-empty"><span>↗</span><h3>给想法一个去处</h3><p>选择「交给 Agent」，任务会在这里持续展示。聊天不会被任务占住。</p></div>}
            <div className="cp-side-note">委派与交接会留下记录。演示不会调用真实工具或消耗模型额度。</div></> : tab === "members" ? <><div className="cp-section-heading"><span>你 ＋ {members.length} 位 Agent</span><button onClick={() => setGroupOpen(true)}>新建群</button></div>
              <div className="cp-member-card"><span className="cp-user-avatar">你</span><div><strong>你</strong><p>设定方向，做出决定</p></div><small>所有者</small></div>
              {members.map(agent => <div className="cp-member-card" key={agent.id}><Avatar agent={agent} /><div><strong>{agent.name}{agent.id === conversation.coordinator && <small>协调者</small>}</strong><p>{agent.role}</p><button onClick={() => setEditingAgent(agent)}>模型、工具与记忆 ↗</button></div></div>)}
              <button className="cp-button cp-full" onClick={addAgent}>＋ 创建 Agent</button><div className="cp-side-note">群里共享目标和成果。Agent 的私有记忆从各自设置中查看。</div></> : <><div className="cp-section-heading"><span>全部会话 · 待你处理</span><span>{pending.length} 项</span></div>
                {!pending.length && <div className="cp-empty"><span>◇</span><h3>现在无需你介入</h3><p>在成果文档中选择「演示交付确认」，体验任务如何向你请求决定。</p></div>}
                {pending.map(request => { const run = state.runs.find(item => item.id === request.run)!; return <article className="cp-request" key={request.id}><span className="cp-eyebrow">交付确认 · 演示</span><h3>{run.title}</h3><p>模拟确认将成果发送到飞书。点击后仅记录演示决定，没有实际发送。</p><div><button className="cp-button" onClick={() => dispatch({ type: "decide", id: request.id, approved: false })}>拒绝</button><button className="cp-button cp-primary" onClick={() => dispatch({ type: "decide", id: request.id, approved: true })}>确认演示</button></div><button className="cp-text-button" onClick={() => { select(request.conversation); setArtifactId(run.id); }}>查看原任务成果 ↗</button></article>; })}</>}
        </div></aside>}
    </div>
    {groupOpen && <GroupForm agents={state.agents} onClose={() => setGroupOpen(false)} onCreate={(title, members, goal) => { dispatch({ type: "group", title, members, goal }); setGroupOpen(false); setTarget(""); setUpdateRun(""); }} />}
    {editingAgent && <AgentForm agent={editingAgent} agents={state.agents} onClose={() => setEditingAgent(null)} onSave={agent => { dispatch({ type: "agent", agent }); setEditingAgent(null); }} />}
    {currentArtifact?.artifact && <Modal title="成果文档 · 演示" onClose={() => setArtifactId("")}><div className="cp-document"><div className="cp-document-label">LOCAL ARTIFACT / 结构样例</div><pre>{currentArtifact.artifact}</pre></div>
      <footer className="cp-document-footer"><span>未生成真实报告，未发送到外部服务</span><button className="cp-button cp-primary" disabled={state.requests.some(request => request.run === currentArtifact.id)} onClick={() => {
        dispatch({ type: "request", run: currentArtifact.id }); setArtifactId(""); setInspector(true); setTab("inbox");
      }}>{state.requests.some(request => request.run === currentArtifact.id) ? "已处理或已加入待办" : "演示交付确认"}</button></footer></Modal>}
    {resetOpen && <Modal title="重置原型演示？" onClose={() => setResetOpen(false)}><div className="cp-form"><p>清除原型中的群、消息、Agent 配置和演示任务，恢复初始场景。真实聊天、记忆和设置不受影响。</p><footer><button className="cp-button" onClick={() => setResetOpen(false)}>取消</button><button className="cp-button cp-primary" onClick={() => {
      dispatch({ type: "reset" }); setAutomatic(false); setDrafts({}); setUpdateRun(""); setTarget(""); setMode("message"); setResetOpen(false);
    }}>确认重置原型</button></footer></div></Modal>}
  </section>;
}
