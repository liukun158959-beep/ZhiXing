import { usePageActive } from "./page-stack";
import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Button } from "reend-components";
import { rpc, type BackendInfo } from "./api";

export type FeishuAgentStatus = {
  ok: boolean; enabled: boolean; connected: boolean; state: string;
  error: string; diagnostic: string; last_reply: string;
  menu_connected?: boolean; menu_error?: string;
  binding: { app_id?: string; app_name?: string; owner_name?: string; owner_id?: string };
  settings?: Settings;
  connection_attempts?: number; connected_at?: number; next_retry_at?: number; failure_kind?: string;
  connection_events?: { at: number; stage: string; kind: string; message: string; retry_in: number }[];
};

type Settings = { profile: string; auto_start: boolean; auto_reconnect: boolean; retry_min: number; retry_max: number };
type Profile = { name: string; appId: string; brand: string; effective: boolean; user?: string };
const DEFAULTS: Settings = { profile: "", auto_start: true, auto_reconnect: true, retry_min: 2, retry_max: 30 };

const STATES: Record<string, string> = {
  stopped: "未接入", connecting: "正在连接", connected: "已接入", reconnecting: "正在重连", error: "接入未成功",
};
const FAILURE_KINDS: Record<string, string> = { network: "网络或服务", rate_limit: "限流", credentials: "应用密钥",
  permission: "机器人权限", configuration: "应用配置", occupied: "长连接占用", verification: "身份校验",
  binding: "绑定身份不一致", user_auth: "用户授权", setup: "监听设置" };

export function FeishuAgentPane({ info, debug = false }: { info: BackendInfo | null; debug?: boolean }) {
  const pageActive = usePageActive();
  const [snap, setSnap] = useState<FeishuAgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [dirty, setDirty] = useState(false);
  const [resetBinding, setResetBinding] = useState(false);
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState("");
  const [check, setCheck] = useState("");
  useEffect(() => {
    if (!pageActive || !info || debug) return;
    let active = true;
    const refresh = async () => {
      try {
        const value = await rpc<FeishuAgentStatus>(info, "load_feishu_agent");
        if (active) setSnap(value);
      } catch (err) { if (active) setError(String(err)); }
    };
    void refresh();
    void rpc<{ ok: boolean; profiles: Profile[] }>(info, "list_feishu_agent_profiles").then((value) => {
      if (active) setProfiles(value.profiles || []);
    }).catch((err) => { if (active) setError(String(err)); });
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pageActive, info, debug]);

  useEffect(() => {
    if (dirty) return;
    const saved = snap?.settings || DEFAULTS;
    setSettings({ ...saved, profile: saved.profile || profiles.find((row) => row.effective)?.name || profiles[0]?.name || "" });
  }, [snap?.settings, profiles, dirty]);

  function edit<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setDirty(true); setMessage(""); setCheck("");
  }

  async function refreshProfiles() {
    if (!info || debug || busy) return;
    setBusy(true); setError("");
    try {
      const value = await rpc<{ profiles: Profile[] }>(info, "list_feishu_agent_profiles");
      setProfiles(value.profiles || []);
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }

  async function configure(action: "save" | "secret" | "check") {
    if (!info || debug || busy) return;
    setBusy(true); setError(""); setMessage("");
    const enteredSecret = secret;
    if (action === "secret") setSecret("");
    try {
      if (action === "save") {
        const value = await rpc<FeishuAgentStatus>(info, "save_feishu_agent_settings", { ...settings, reset_binding: resetBinding });
        if (!value.ok) throw new Error(value.error || "设置未保存。");
        setSnap(value); setDirty(false); setResetBinding(false); setCheck(""); setMessage("设置已保存，重新接入后生效。");
      } else if (action === "secret") {
        const value = await rpc<{ ok: boolean; message?: string; error?: string }>(info, "update_feishu_agent_credentials",
          { profile: settings.profile, app_secret: enteredSecret });
        if (!value.ok) throw new Error(value.error || "密钥更新失败。");
        setMessage(value.message || "密钥已更新。"); setCheck("");
      } else {
        const value = await rpc<{ ok: boolean; message?: string; error?: string; checked_at?: string }>(info, "check_feishu_agent_connection", { profile: settings.profile });
        if (!value.ok) throw new Error(value.error || "连接检查失败。");
        setCheck(`${value.message || ""} 检查时间：${value.checked_at || "刚刚"}`);
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function change(start: boolean) {
    if (!info || debug || busy) return;
    setBusy(true); setError("");
    try {
      const value = await rpc<FeishuAgentStatus>(info, start ? "start_feishu_agent" : "stop_feishu_agent");
      if (!value.ok) throw new Error(value.error || "飞书接入未成功。");
      setSnap(value);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  const working = snap?.state === "connected" || snap?.state === "connecting" || snap?.state === "reconnecting";
  const locked = busy || working || !info || debug;
  const selected = profiles.find((row) => row.name === settings.profile);
  function openLink(url: string) {
    if (isTauri()) void invoke("open_link", { url }); else window.open(url, "_blank", "noopener");
  }
  return <section className="mt-10 max-w-2xl rounded-xl border border-border p-5" aria-label="飞书 tebb Agent">
    <h2 className="text-base font-semibold">在飞书使用 tebb Agent</h2>
    <p className="mt-2 text-sm leading-6 text-muted-foreground">
      接入本机飞书 CLI 已配置的应用。接入后，你可以在飞书私聊机器人，使用 tebb 的模型、技能、知识库和工具。
      仅接受绑定的登录用户；tebb 需要保持运行，聊天历史与桌面当前对话分开保存。
    </p>
    <p className="mt-4 text-sm" data-feishu-agent-state>{STATES[snap?.state || "stopped"] || "读取状态中"}</p>
    {snap?.connected && <p className="mt-2 text-xs text-white/50">记忆菜单：{snap.menu_connected ? "已监听" : "等待连接"}。菜单动作需配置为 memory_request_from_feishu，订阅 application.bot.menu_v6 后发布应用。</p>}
    {snap?.menu_error && <p role="alert" className="mt-2 text-sm text-amber-300">{snap.menu_error}</p>}
    {snap?.binding?.app_id ? <p className="mt-2 text-sm text-muted-foreground">
      应用：{snap.binding.app_name || snap.binding.app_id}<br />
      允许私聊：{snap.binding.owner_name || snap.binding.owner_id}
    </p> : null}
    {error || snap?.error ? <p role="alert" className="mt-3 whitespace-pre-wrap text-sm text-destructive">{error || snap?.error}</p> : null}
    {snap?.diagnostic ? <p className="mt-2 text-sm text-muted-foreground">{snap.diagnostic}</p> : null}
    {!!snap?.next_retry_at && <p className="mt-2 text-xs text-muted-foreground">下次重试：{new Date(snap.next_retry_at * 1000).toLocaleTimeString()}，会重新校验同一应用和绑定用户。</p>}
    {!!snap?.connection_events?.length && <details className="mt-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer">连接诊断 · {snap.connection_attempts || 0} 次尝试</summary>
      <ol className="mt-2 space-y-2">{[...snap.connection_events].reverse().map((event, index) => <li key={`${event.at}-${index}`}>
        {new Date(event.at * 1000).toLocaleTimeString()} · {event.stage === "verifying" ? "身份校验" : STATES[event.stage] || event.stage}
        {event.kind ? ` · ${FAILURE_KINDS[event.kind] || "连接异常"}` : ""}{event.message ? `：${event.message}` : ""}{event.retry_in ? `（${event.retry_in} 秒后重试）` : ""}
      </li>)}</ol>
    </details>}
    {snap?.last_reply ? <p className="mt-2 text-xs text-muted-foreground">最近回复：{snap.last_reply}</p> : null}
    <fieldset className="mt-5 space-y-4 rounded-lg bg-muted/30 p-4" disabled={locked}>
      <legend className="px-1 text-sm font-medium">长连接设置</legend>
      <label className="block text-sm">飞书应用
        <select aria-label="飞书应用" className="mt-2 block w-full rounded-md border border-border bg-background p-2" value={settings.profile}
          onChange={(event) => edit("profile", event.target.value)}>
          {!profiles.length ? <option value="">请先配置飞书 CLI 应用</option> : null}
          {profiles.map((row) => <option key={row.name} value={row.name}>{row.name} · {row.appId}{row.user ? ` · ${row.user}` : ""}</option>)}
        </select>
      </label>
      <Button type="button" variant="secondary" size="sm" disabled={locked} onClick={() => void refreshProfiles()}>刷新应用列表</Button>
      {selected ? <p className="select-text text-xs text-muted-foreground">App ID：{selected.appId} · {selected.brand === "lark" ? "Lark" : "飞书"}</p> : null}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.auto_start} onChange={(event) => edit("auto_start", event.target.checked)} />tebb 启动时自动接入</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.auto_reconnect} onChange={(event) => edit("auto_reconnect", event.target.checked)} />网络断开后自动重连</label>
      <div className="flex flex-wrap gap-4">
        <label className="text-sm">初始重连间隔（秒）<input aria-label="初始重连间隔" type="number" min={1} max={300} step={1} value={settings.retry_min}
          className="mt-2 block w-28 rounded-md border border-border bg-background p-2" onChange={(event) => edit("retry_min", Number(event.target.value))} /></label>
        <label className="text-sm">最大重连间隔（秒）<input aria-label="最大重连间隔" type="number" min={1} max={300} step={1} value={settings.retry_max}
          className="mt-2 block w-28 rounded-md border border-border bg-background p-2" onChange={(event) => edit("retry_max", Number(event.target.value))} /></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={resetBinding} onChange={(event) => { setResetBinding(event.target.checked); setDirty(true); }} />下次接入时重新绑定所选应用的登录用户</label>
      <p className="text-xs leading-5 text-muted-foreground">更换应用会清除旧的私聊绑定；个人日程等工具继续使用 CLI 原有默认应用。修改前请先停止接入。</p>
      <Button type="button" variant="secondary" size="sm" disabled={locked || !dirty || !settings.profile} onClick={() => void configure("save")}>保存连接设置</Button>
      <div className="border-t border-border pt-4">
        <label className="block text-sm">更新 App Secret<input aria-label="App Secret" type="password" autoComplete="new-password" value={secret}
          className="mt-2 block w-full rounded-md border border-border bg-background p-2" placeholder="填写重置后的密钥" onChange={(event) => setSecret(event.target.value)} /></label>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">更新所选应用的凭证。密钥交由飞书 CLI 保存，提交后清空输入框。</p>
        <Button type="button" variant="secondary" size="sm" className="mt-3" disabled={locked || !settings.profile || !secret.trim()} onClick={() => void configure("secret")}>更新应用密钥</Button>
      </div>
    </fieldset>
    {dirty ? <p className="mt-2 text-xs text-muted-foreground">有未保存的连接设置，请先保存。</p> : null}
    {message ? <p role="status" className="mt-3 text-sm">{message}</p> : null}
    {check ? <p role="status" className="mt-3 whitespace-pre-wrap text-sm">{check}</p> : null}
    <div className="mt-4 flex gap-3">
      <Button type="button" variant="primary" size="sm" disabled={locked || dirty} onClick={() => void change(true)}>
        {snap?.state === "error" ? "重新接入" : "接入飞书"}
      </Button>
      <Button type="button" variant="secondary" size="sm" disabled={busy || (!working && !snap?.enabled) || !info || debug} onClick={() => void change(false)}>停止接入</Button>
      <Button type="button" variant="secondary" size="sm" disabled={busy || !info || debug || !settings.profile} onClick={() => void configure("check")}>检查连接占用</Button>
    </div>
    {selected ? <button type="button" className="mt-3 text-xs underline" onClick={() => openLink(`https://${selected.brand === "lark" ? "open.larksuite.com" : "open.feishu.cn"}/app/${selected.appId}`)}>打开所选应用后台</button> : null}
    <p className="mt-3 text-xs leading-6 text-muted-foreground">接收方式：长连接 · 事件：im.message.receive_v1 · 接收范围：绑定用户的私聊。平台心跳由 CLI 管理。</p>
    <p className="mt-4 text-xs leading-6 text-muted-foreground">
      在应用后台开启机器人能力，选择长连接订阅「接收消息」事件，并开通接收单聊消息、以应用身份发送消息权限后发布。
      私聊发送 /help 查看指令，/new 开新对话，/skills 查看技能，/kb 提问知识库。
    </p>
    <button type="button" className="mt-2 text-xs underline" onClick={() => {
      const url = "https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case";
      openLink(url);
    }}>查看飞书官方长连接开发文档</button>
  </section>;
}
