import { useRef, useState } from "react";
import { rpc, type BackendInfo } from "./api";
import type { ModelList } from "./settings";

export type SetupStatus = {
  ok: boolean; show: boolean; configured: boolean; data_dir: string; assets_dir: string;
  checks: { github: boolean; feishu: boolean; knowledge: boolean; pet: boolean };
};

export function SetupGuide(props: {
  info: BackendInfo; status: SetupStatus; models: ModelList;
  onModels: (models: ModelList) => void; onClose: (completed?: boolean) => void;
  onNavigate: (pane: "settings" | "board" | "feishu", sub?: string) => void;
}) {
  const active = props.models.items.find((item) => item.id === props.models.active);
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState(active?.base_url || "");
  const [model, setModel] = useState(active?.model || "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(!!active);
  const [tested, setTested] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const button = "desk-btn desk-btn-lg";
  async function submit(test: boolean) {
    setBusy(true); setError(""); setNotice("");
    try {
      const payload = { id: active?.id || "", base_url: url.trim(), model: model.trim(), api_key: key.trim() };
      if (test) {
        const result = await rpc<{ ok: boolean; error?: string; message?: string }>(props.info, "test_model", { payload });
        if (!result.ok) throw new Error(result.error || "连通测试失败。");
        setTested(true); setNotice(result.message || "连通正常。");
      } else {
        const result = await rpc<ModelList>(props.info, "save_model_entry", { payload });
        if (!result.ok) throw new Error(result.error || "保存失败。");
        props.onModels(result); setKey(""); setSaved(true); setNotice("模型已保存，可以继续或测试连通。");
      }
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  async function finish(pane?: "settings" | "board" | "feishu", sub?: string) {
    setBusy(true); setError("");
    try {
      const result = await rpc<{ ok: boolean }>(props.info, "complete_onboarding");
      if (!result.ok) throw new Error("引导状态保存失败，请重试。");
      props.onClose(true);
      if (pane) props.onNavigate(pane, sub);
    } catch (err) { setError(String(err)); setBusy(false); }
  }
  function change(fn: () => void) { fn(); setSaved(false); setTested(false); setNotice(""); setError(""); }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6" data-onboarding>
      <section role="dialog" aria-modal="true" aria-labelledby="setup-title" className="flex max-h-full w-full max-w-2xl flex-col rounded-xl border border-border bg-background shadow-2xl"
        onKeyDown={(ev) => {
          if (ev.key === "Escape" && !busy) { ev.stopPropagation(); props.onClose(); }
          if (ev.key !== "Tab") return;
          const elements = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input, a[href]"));
          const first = elements[0], last = elements[elements.length - 1];
          if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
        }}>
        <header className="flex items-start justify-between border-b border-border px-7 py-5">
          <div><p className="mb-1 text-xs text-primary">首次使用 · {step + 1} / 3</p><h1 id="setup-title" className="text-xl font-semibold">{["欢迎使用 tebb", "连接你的模型", "按需启用其他功能"][step]}</h1></div>
          <button ref={closeRef} autoFocus type="button" className={button} disabled={busy} onClick={() => props.onClose()}>稍后设置</button>
        </header>
        <div className="overflow-y-auto px-7 py-6 text-sm leading-6">
          {step === 0 ? <div className="space-y-4">
            <p>先连接一个兼容 OpenAI Chat Completions 协议的模型，就能开始对话、保存记忆和整理笔记。其他功能可以之后再配置。</p>
            <p>准备好服务商提供的 <strong>API 地址（Base URL）、API Key、模型 ID</strong>。网页聊天账号不一定包含 API 服务，请到服务商控制台查看。</p>
            <p>配置入口始终在主窗左侧「设置 → 模型」。本引导也可在设置页重新打开。</p>
            <div className="rounded-lg border border-border p-4 text-muted-foreground">Key 保存在这台电脑的配置文件中，页面不会回显。不要把 Key 写进聊天、截图或共享备份。测试连通和对话会把内容发给你填写的服务商，并可能按其规则计费。</div>
          </div> : step === 1 ? <div className="space-y-4">
            <p>与「设置 → 模型」共用同一份配置。先保存，再测试连通；测试成功后可直接开始对话。</p>
            <label className="block">API 地址（Base URL）<input className="mt-1 w-full border border-border bg-background px-3 py-2" value={url} disabled={busy} autoComplete="off" placeholder="https://api.example.com/v1" onChange={(ev) => change(() => setUrl(ev.target.value))} /><span className="text-xs text-muted-foreground">填写服务商的完整接口根地址，通常包含 /v1；不要填网页聊天地址，也不要加 /chat/completions。</span></label>
            <label className="block">模型 ID<input className="mt-1 w-full border border-border bg-background px-3 py-2" value={model} disabled={busy} autoComplete="off" placeholder="服务商模型列表中的准确 ID" onChange={(ev) => change(() => setModel(ev.target.value))} /><span className="text-xs text-muted-foreground">照抄控制台的模型 ID，大小写和版本保持一致。使用工具时，模型还需支持 tool calling。</span></label>
            <label className="block">API Key<input className="mt-1 w-full border border-border bg-background px-3 py-2" type="password" value={key} disabled={busy} autoComplete="off" placeholder={active?.has_key ? "已保存，留空保留原 Key" : "从服务商控制台复制"} onChange={(ev) => change(() => setKey(ev.target.value))} /></label>
            <div className="flex gap-2"><button type="button" className={`${button} desk-btn-solid`} disabled={busy} onClick={() => void submit(false)}>保存模型</button><button type="button" className={button} disabled={busy} onClick={() => void submit(true)}>测试连通</button></div>
            <p className="text-xs text-muted-foreground">401 / 403：检查 Key 与权限；404：检查 Base URL 和模型 ID；超时：检查网络。保存成功不代表接口已连通。</p>
            {saved && !tested ? <p className="text-xs text-muted-foreground">已保存，还未在本次引导中验证连通；可稍后在设置页测试。</p> : null}
          </div> : <div className="space-y-4">
            <p>{props.models.items.length ? "模型配置已保存。以下功能按需设置。" : "尚未配置模型，可先浏览界面，开始对话前到设置页补齐。"}</p>
            {[
              { title: "飞书日程、任务和文档", state: props.status.checks.feishu ? "已检测到 lark-cli，登录态在飞书页查看" : "需要安装 lark-cli", text: "安装后先执行 lark-cli config init，再到「飞书」页登录并授权需要的范围。", pane: "feishu" as const },
              { title: "GitHub 看板", state: props.status.checks.github ? "已检测到 gh，仍需登录" : "需要 GitHub CLI", text: "安装 gh 并执行 gh auth login，再打开「看板 → GitHub」。只读取当前登录账号可见的仓库。", pane: "board" as const, sub: "github" },
              { title: "知识库", state: props.status.checks.knowledge ? "检索运行库已安装" : "需要额外安装检索运行库", text: "在左侧「知识库」选择并下载向量 / 重排模型，再添加文档。首次下载较大；便携版按使用说明安装知识库扩展。", pane: "board" as const, sub: "knowledge" },
              { title: "桌宠形象与外观", state: props.status.checks.pet ? "已检测到形象与 Core" : "尚未添加 Live2D 素材", text: `在 ${props.status.assets_dir} 放入 Core/live2dcubismcore.js 与 skins/kaltsit/kaltsit.model3.json 及引用素材，重启后加载。素材未包含在公开发布包中；主题、背景和提示词在设置页调整。`, pane: "settings" as const },
            ].map((item) => <div key={item.title} className="rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-3"><strong>{item.title}</strong><button type="button" className={button} disabled={busy} onClick={() => void finish(item.pane, item.sub)}>前往设置</button></div><p className="text-xs text-primary">{item.state}</p><p className="mt-1 text-muted-foreground">{item.text}</p></div>)}
            <p><strong>MCP 与技能：</strong>在用户目录新建 mcp.json 配置外部工具，在对话输入框通过 / 选择；技能随发布包提供。配置示例见使用说明。</p>
            <p className="break-all"><strong>配置、聊天和日志目录：</strong><br />{props.status.data_dir}</p>
            <p className="text-muted-foreground">备份这个目录可以保留配置和记忆。升级替换程序文件即可；备份包含密钥，请妥善保管。</p>
          </div>}
          {notice ? <p role="status" className="mt-4 text-primary">{notice}</p> : null}
          {error ? <p role="alert" className="mt-4 text-destructive">{error}</p> : null}
        </div>
        <footer className="flex justify-between gap-3 border-t border-border px-7 py-4">
          <button type="button" className={button} disabled={busy || step === 0} onClick={() => { setStep(step - 1); setNotice(""); setError(""); }}>上一步</button>
          {step === 1 && !saved ? <button type="button" className={button} disabled={busy} onClick={() => setStep(2)}>先浏览，稍后配置</button> : null}
          {step < 2 ? <button type="button" className={`${button} desk-btn-solid`} disabled={busy || (step === 1 && !saved)} onClick={() => { setStep(step + 1); setNotice(""); setError(""); }}>{step === 0 ? "开始配置" : "继续"}</button> : <button type="button" className={`${button} desk-btn-solid`} disabled={busy} onClick={() => void finish()}>完成引导</button>}
        </footer>
      </section>
    </div>
  );
}
