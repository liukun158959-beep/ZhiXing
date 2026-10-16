import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { backendInfo, rpc, type BackendInfo } from './api';
import { runActive, RUN_LABELS, type DemoState } from './chat-prototype-state';
import { StreamText } from './stream-text';
import { AppIcon } from './companion-ui';

type Progress = { enabled: boolean; task?: { id: string; state: string; text: string; status: string; answer: string; events: string[] } };
export function PetChat({ backend }: { backend?: BackendInfo }) {
  const [info, setInfo] = useState<BackendInfo | null>(backend || null), [state, setState] = useState<DemoState | null>(null);
  const [visible, setVisible] = useState(true), [conversation, setConversation] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [menu, setMenu] = useState<{x:number;y:number} | null>(null), [progress, setProgress] = useState<Progress | null>(null);
  const [model, setModel] = useState(''), [pollError, setPollError] = useState('');
  const scroller = useRef<HTMLDivElement>(null), following = useRef(true), generation = useRef(0), alive = useRef(true);
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const cid = conversation || state?.selected || '', draft = drafts[cid] || '';
  const current = state?.conversations.find(c => c.id === cid);
  const runs = state?.runs.filter(r => r.conversation === cid) || [], active = runs.filter(runActive);
  const messages = state?.messages.filter(m => m.conversation === cid) || [];
  const accept = (next: DemoState) => { setState(old => !old || (next.revision || 0) >= (old.revision || 0) ? next : old); setConversation(old=>old || next.selected); };
  useEffect(() => {
    alive.current = true;
    if (!backend) void backendInfo().then(value => { if (alive.current) setInfo(value); }).catch(e => { if (alive.current) setError(String(e)); });
    let disposed = false; let off: (() => void) | undefined;
    if (isTauri()) void listen<boolean>('pet-chat-visible', event => setVisible(event.payload)).then(unlisten => { if (disposed) unlisten(); else off = unlisten; });
    const link = (event:Event) => { const detail=(event as CustomEvent).detail;if(detail?.kind==='web') void invoke('open_link',{url:detail.url}).catch(e=>setError(String(e))); };
    window.addEventListener('desk-open-preview',link);
    return () => { window.removeEventListener('desk-open-preview',link);alive.current = false; disposed = true; off?.(); };
  }, [backend]);
  useEffect(() => {
    if (!info || !visible) return;
    let live = true, fetching = false;
    const refresh = async () => {
      if (fetching) return; fetching = true;
      try {
        const [collab, task] = await Promise.all([rpc<{ state: DemoState }>(info, 'load_collaboration'), rpc<Progress>(info, 'load_task_progress')]);
        if (live) { accept(collab.state); setProgress(task); setPollError(''); }
      } catch (e) { if (live) setPollError(String(e)); } finally { fetching = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 600);
    return () => { live = false; window.clearInterval(timer); };
  }, [info?.port, info?.token, visible]);
  useEffect(() => {
    if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [state?.revision, progress?.task?.answer, progress?.task?.status, cid, visible]);
  async function close() { setMenu(null); await invoke('set_pet_chat_visible', { visible: false }).catch(e => setError(String(e))); }
  async function openMain() {
    try { if(info && cid) await rpc(info,'collaboration_action',{action:{type:'select',id:cid,conversation:cid,request_id:crypto.randomUUID()}});await invoke('show_main'); } catch(e) {setError(String(e));}
  }
  async function send() {
    if (!info || !cid || !draft.trim() || busy) return;
    const text = draft, selected = cid, stamp = ++generation.current;
    const body = { type: 'send', conversation: selected, text, target: '', mode: 'auto', model_id: model };
    const fingerprint = JSON.stringify(body);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = await rpc<{ state: DemoState }>(info, 'collaboration_action', { action: { ...body, request_id: pending.current.id } });
      if (!alive.current || stamp !== generation.current) return;
      accept(result.state); pending.current = null;
      setDrafts(old => old[selected] === text ? { ...old, [selected]: '' } : old); following.current = true;
    } catch (e) { if (alive.current) setError(String(e) + '；重试相同内容会沿用提交编号。'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function stop(id: string) {
    if (!info) return;
    try { const result = await rpc<{state:DemoState}>(info, 'collaboration_action', { action: { type:'cancel', id, conversation:cid, request_id:crypto.randomUUID() } }); accept(result.state); }
    catch(e) { setError(String(e)); }
  }
  return <main className="pet-chat-window" onContextMenu={event => { if ((event.target as HTMLElement).closest('input,textarea')) return; event.preventDefault(); setMenu({x:Math.max(8,Math.min(event.clientX,window.innerWidth-160)), y:Math.max(8,Math.min(event.clientY,window.innerHeight-76))}); }}>
    <header className="pet-chat-title" data-tauri-drag-region><strong data-tauri-drag-region>tebb.</strong><span data-tauri-drag-region>{active.length ? '正在执行' : '随时聊聊'}</span><button title="在主窗口打开" aria-label="在主窗口打开" onClick={() => void openMain()}>↗</button><button aria-label="关闭对话框" title="关闭，任务继续执行" onClick={() => void close()}>×</button></header>
    <div className="pet-chat-controls"><select aria-label="当前会话" value={cid} onChange={e => { setConversation(e.target.value); setModel(''); following.current = true; }}>{state?.conversations.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select><select aria-label="本轮模型" value={model} onChange={e => setModel(e.target.value)}><option value="">默认模型</option>{state?.models?.map(m => <option key={m.id} value={m.id}>{m.model}</option>)}</select></div>
    <div className="pet-chat-scroll" ref={scroller} onScroll={e => { const el=e.currentTarget; following.current = el.scrollHeight-el.scrollTop-el.clientHeight < 40; }} aria-label="聊天与任务过程">
      {!state && <p className="pet-chat-placeholder">正在连接当前会话…</p>}
      {state && !messages.length && <p className="pet-chat-placeholder">{current?.title || '当前会话'}<br/>可以直接提问，也可以 @ 伙伴安排任务。</p>}
      {messages.map(message => { const run=runs.find(r=>r.id===message.run);return <article key={message.id} className={`pet-chat-message ${message.sender==='user'?'from-user':''}`}><small>{message.sender==='user'?'你':state?.agents.find(a=>a.id===message.sender)?.name || 'tebb'}</small><StreamText text={message.text || (run && runActive(run) ? run.status || '正在处理…' : '')} active={!!run && runActive(run)} /></article>; })}
      {runs.filter(r=>!['chat','route','compress'].includes(r.kind || '')).map(run => <details className={`pet-chat-task ${runActive(run)?'is-running':''}`} key={run.id} open><summary><AppIcon name="tasks" />{run.title} · {RUN_LABELS[run.state]}</summary><ol>{run.events.map((event,index)=><li key={index}><span className="tebb-stream-new">{event}</span></li>)}</ol>{runActive(run) && <button onClick={()=>void stop(run.id)}>停止任务</button>}{run.error && <p role="alert">{run.error}</p>}</details>)}
      {progress?.enabled && progress.task && <details className="pet-chat-task" open><summary>其他通道 · {progress.task.text}</summary><ol>{progress.task.events?.map((event,index)=><li key={index}><span className="tebb-stream-new">{event}</span></li>)}</ol><StreamText text={progress.task.answer || progress.task.status} active={['running','queued','cancelling'].includes(progress.task.state)} /></details>}
    </div>
    {(error || pollError) && <p className="pet-chat-error" role="alert">{error || pollError}</p>}
    <form className="pet-chat-composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea value={draft} maxLength={4000} aria-label="浮动聊天消息" placeholder="输入消息，支持 Markdown…" onChange={e=>setDrafts(old=>({...old,[cid]:e.target.value}))} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();void send();}}}/><footer><span>{active.length ? <><i className="tebb-stream-cursor" />任务执行中 · 可继续聊天</>:'Enter 发送 · Shift+Enter 换行'}</span><button type="submit" disabled={busy || !cid || !draft.trim()}>发送 ↑</button></footer></form>
    {menu && <><button className="pet-chat-menu-dismiss" aria-label="收起菜单" onClick={()=>setMenu(null)}/><div className="pet-chat-menu" role="menu" style={{left:menu.x,top:menu.y}}><button role="menuitem" onClick={()=>void close()}>关闭对话框</button><small>任务继续，重新打开可恢复</small></div></>}
  </main>;
}
