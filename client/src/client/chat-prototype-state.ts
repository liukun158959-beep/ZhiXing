// Local interaction model only. No model, tool, credential, or backend imports.
export type DemoAgent = { id: string; name: string; role: string; mark: string; tone: string; model: string; tools: string[]; memory: string };
export type DemoConversation = { id: string; title: string; kind: "dm" | "group"; members: string[]; coordinator: string; goal: string };
export type DemoMessage = { id: string; conversation: string; sender: string; text: string; run?: string; kind?: "result" | "notice" };
export type DemoRun = { id: string; conversation: string; agent: string; title: string; state: "running" | "waiting" | "succeeded" | "cancelled";
  step: number; dependency?: string; updates: string[]; applied: number; events: string[]; artifact?: string };
export type DemoRequest = { id: string; conversation: string; run: string; state: "pending" | "approved" | "rejected" };
export type DemoState = { version: 1; next: number; selected: string; agents: DemoAgent[]; conversations: DemoConversation[]; messages: DemoMessage[];
  runs: DemoRun[]; requests: DemoRequest[]; notice: string };
export type DemoAction =
  | { type: "select"; id: string }
  | { type: "send"; text: string; target: string; mode: "message" | "task"; run?: string }
  | { type: "advance" }
  | { type: "cancel"; id: string }
  | { type: "group"; title: string; members: string[]; goal: string }
  | { type: "agent"; agent: DemoAgent }
  | { type: "request"; run: string }
  | { type: "decide"; id: string; approved: boolean }
  | { type: "reset" };

export const DEMO_STORAGE = "tebb.chat-prototype.v1";
export const runActive = (run: DemoRun) => run.state === "running" || run.state === "waiting";
export const RUN_LABELS: Record<DemoRun["state"], string> = { running: "模拟执行中", waiting: "等待前序成果", succeeded: "演示完成", cancelled: "已停止演示" };
export const STEP_LABELS = ["整理任务与资料范围", "核对资料并提炼要点", "整理成果与交接"];

export function initialDemo(): DemoState {
  return {
    version: 1, next: 20, selected: "group-research", notice: "", requests: [],
    agents: [
      { id: "tebb", name: "tebb", role: "协调目标、拆分工作、汇总成果", mark: "t", tone: "gold", model: "通用模型 · 演示", tools: ["文件"], memory: "演示偏好：先交付结论，再展开依据。" },
      { id: "research", name: "研究员", role: "查找一手来源，比较技术方案", mark: "R", tone: "sage", model: "研究模型 · 演示", tools: ["联网搜索", "文件"], memory: "演示偏好：比较项目时列出许可证和部署门槛。" },
      { id: "writer", name: "写作者", role: "整理结构，将资料写成可交付文档", mark: "W", tone: "lavender", model: "写作模型 · 演示", tools: ["文件", "飞书"], memory: "演示偏好：英文技术名词旁保留中文解释。" },
    ],
    conversations: [
      { id: "group-research", title: "AI 研究室", kind: "group", members: ["tebb", "research", "writer"], coordinator: "tebb", goal: "一起研究开源 Agent，把结论整理成有依据的报告。" },
      ...["tebb", "research", "writer"].map(id => ({ id: `dm-${id}`, title: id === "tebb" ? "tebb" : id === "research" ? "研究员" : "写作者", kind: "dm" as const, members: [id], coordinator: id, goal: "独立会话，记忆按 Agent 展示。" })),
    ],
    messages: [
      { id: "m1", conversation: "group-research", sender: "notice", text: "你创建了 AI 研究室，邀请 tebb、研究员和写作者加入。所有内容均为本地演示。", kind: "notice" },
      { id: "m2", conversation: "group-research", sender: "user", text: "比较三个开源 Agent 项目，帮我看看哪个更适合自部署。", run: "r1" },
      { id: "m3", conversation: "group-research", sender: "tebb", text: "我来协调。研究员先整理比较依据，写作者收到资料后生成报告。你可以继续聊天，也可以给任务补充要求。", run: "r1" },
    ],
    runs: [
      { id: "r1", conversation: "group-research", agent: "research", title: "比较开源 Agent 的自部署方案", state: "running", step: 0, updates: [], applied: 0, events: ["tebb → 研究员：整理项目比较依据（模拟委派）"] },
      { id: "r2", conversation: "group-research", agent: "writer", title: "整理自部署比较报告", state: "waiting", step: 0, dependency: "r1", updates: [], applied: 0, events: ["tebb → 写作者：等待研究成果后成文（模拟委派）"] },
    ],
  };
}

function artifact(run: DemoRun, agent: DemoAgent) {
  return `# ${run.title}\n\n> 交互演示，未进行联网检索、模型分析或外部写入。以下是成果结构样例。\n\n` +
    `负责人：${agent.name}\n\n## 任务目标\n${run.title}\n\n## 已应用的补充要求\n${run.updates.join("\n\n") || "无补充要求。"}\n\n` +
    "## 正式成果将包含\n- 结论与适用场景\n- 可核实的来源与比较依据\n- 部署、成本与限制\n- 后续行动建议\n\n真实执行接入后，此处由实际成果替换。";
}

export function demoReducer(previous: DemoState, action: DemoAction): DemoState {
  if (action.type === "reset") return initialDemo();
  // Clone so React strict mode and callers can safely replay an action.
  const state: DemoState = JSON.parse(JSON.stringify(previous));
  state.notice = "";
  const id = () => `demo-${state.next++}`;
  const message = (conversation: string, sender: string, text: string, run?: string, kind?: DemoMessage["kind"]) => {
    state.messages.push({ id: id(), conversation, sender, text, run, kind });
  };
  const conversation = state.conversations.find(item => item.id === state.selected)!;
  if (action.type === "select") {
    if (state.conversations.some(item => item.id === action.id)) state.selected = action.id;
  } else if (action.type === "send") {
    const text = action.text.trim().slice(0, 4000);
    if (!text) return previous;
    if (action.run) {
      const run = state.runs.find(item => item.id === action.run && item.conversation === conversation.id);
      if (!run || !runActive(run)) { state.notice = "这项任务已结束或不属于当前会话，请重新选择。"; return state; }
      run.updates.push(text);
      run.events.push("已接收补充要求，等待下一个演示步骤应用");
      message(conversation.id, "user", text, run.id);
      message(conversation.id, run.agent, "补充要求已接收，将在下一个演示步骤应用。", run.id);
      return state;
    }
    let target = action.target || conversation.coordinator;
    const mention = text.match(/^@([^\s]+)(?:\s|$)/);
    if (mention) {
      const mentioned = state.agents.find(agent => agent.name === mention[1] && conversation.members.includes(agent.id));
      if (!mentioned) { state.notice = "@ 的 Agent 不在当前会话中，请从发送对象中选择。"; return state; }
      target = mentioned.id;
    }
    if (!conversation.members.includes(target)) { state.notice = "发送对象不在当前会话中。"; return state; }
    message(conversation.id, "user", text);
    if (action.mode === "message") {
      const active = state.runs.filter(run => run.conversation === conversation.id && runActive(run));
      message(conversation.id, target, active.length
        ? `收到你的消息。当前有 ${active.length} 项后台任务，聊天可以继续。要修改某项任务，请点任务卡上的「补充要求」。（本地模拟回复）`
        : "收到。这是独立的聊天消息；选择「交给 Agent」可以演示后台任务。（本地模拟回复）");
    } else {
      const delegated = conversation.kind === "group" && target === conversation.coordinator && conversation.members.length > 1;
      const workers = delegated ? conversation.members.filter(member => member !== target).slice(0, 2) : [target];
      const first = id();
      workers.forEach((agent, index) => state.runs.push({ id: index ? id() : first, conversation: conversation.id, agent,
        title: index ? `整理成果：${text}` : text, state: index ? "waiting" : "running", step: 0,
        dependency: index ? first : undefined, updates: [], applied: 0,
        events: [`${state.agents.find(a => a.id === target)!.name} → ${state.agents.find(a => a.id === agent)!.name}：${index ? "等待前序成果" : "开始任务"}（模拟）`] }));
      message(conversation.id, target, delegated ? "已演示拆分与委派。前序任务完成后，成果会交给下一位 Agent；你可以继续发消息。" : "已放入后台任务区，你可以继续聊天或补充要求。", first);
    }
  } else if (action.type === "advance") {
    // Each tick uses the previous snapshot: dependencies never skip a visible handoff.
    for (const run of state.runs) {
      if (!runActive(run)) continue;
      if (run.state === "waiting") {
        if (previous.runs.find(item => item.id === run.dependency)?.state === "succeeded") {
          run.state = "running";
          run.events.push("已收到前序成果，开始整理（模拟交接）");
          message(run.conversation, run.agent, "前序成果已收到，开始接续工作。（模拟交接）", run.id);
        }
        continue;
      }
      if (run.applied < run.updates.length) {
        run.applied = run.updates.length;
        run.events.push(`已应用 ${run.applied} 条补充要求（模拟安全边界）`);
      }
      run.events.push(STEP_LABELS[Math.min(run.step, 2)] + "（模拟）");
      run.step++;
      if (run.step >= 3) {
        run.state = "succeeded";
        run.artifact = artifact(run, state.agents.find(agent => agent.id === run.agent)!);
        message(run.conversation, run.agent, "演示成果已整理好，可打开查看结构样例。未检索资料或生成真实结论。", run.id, "result");
      }
    }
  } else if (action.type === "cancel") {
    const root = state.runs.find(run => run.id === action.id);
    if (!root || !runActive(root)) return previous;
    const cancelled = new Set([root.id]);
    let changed = true;
    while (changed) {
      changed = false;
      state.runs.forEach(run => { if (runActive(run) && run.dependency && cancelled.has(run.dependency) && !cancelled.has(run.id)) { cancelled.add(run.id); changed = true; } });
    }
    state.runs.forEach(run => { if (cancelled.has(run.id) && runActive(run)) { run.state = "cancelled"; run.events.push("演示已停止，已保留进度及补充要求"); } });
    message(root.conversation, "notice", "已停止所选任务及依赖它的后续任务，其他任务继续。", root.id, "notice");
  } else if (action.type === "group") {
    const members = [...new Set(action.members)].filter(member => state.agents.some(agent => agent.id === member));
    if (!action.title.trim() || members.length < 2) { state.notice = "请填写群名，并选择至少两位 Agent。"; return state; }
    const group = { id: id(), title: action.title.trim().slice(0, 40), kind: "group" as const, members,
      coordinator: members.includes("tebb") ? "tebb" : members[0], goal: action.goal.trim().slice(0, 500) };
    state.conversations.push(group); state.selected = group.id;
    message(group.id, "notice", "协作群已创建。选择发送对象，或让协调者分配工作。", undefined, "notice");
  } else if (action.type === "agent") {
    const name = action.agent.name.trim().slice(0, 24);
    if (!name || /[\s@]/.test(name) || state.agents.some(agent => agent.id !== action.agent.id && agent.name === name)) {
      state.notice = "名称不能留空、重复，或包含空格和 @。"; return state;
    }
    const existing = state.agents.find(agent => agent.id === action.agent.id);
    const agent = { ...action.agent, id: existing?.id || id(), name, role: action.agent.role.slice(0, 160), model: action.agent.model.slice(0, 80), memory: action.agent.memory.slice(0, 2000) };
    if (existing) state.agents = state.agents.map(item => item.id === agent.id ? agent : item);
    else state.agents.push(agent);
    const dm = state.conversations.find(item => item.kind === "dm" && item.coordinator === agent.id);
    if (dm) dm.title = name;
    else state.conversations.push({ id: `dm-${agent.id}`, title: name, kind: "dm", members: [agent.id], coordinator: agent.id, goal: "独立会话，记忆按 Agent 展示。" });
    state.notice = "Agent 配置已保存到本地原型，未修改真实模型、权限或记忆。";
  } else if (action.type === "request") {
    const run = state.runs.find(item => item.id === action.run && item.state === "succeeded");
    if (run && !state.requests.some(item => item.run === run.id)) state.requests.push({ id: id(), run: run.id, conversation: run.conversation, state: "pending" });
    state.notice = "交付确认已加入待办，这是交互演示，不会向飞书发送消息。";
  } else if (action.type === "decide") {
    const request = state.requests.find(item => item.id === action.id && item.state === "pending");
    if (!request) return previous;
    request.state = action.approved ? "approved" : "rejected";
    message(request.conversation, "notice", action.approved ? "已确认交付演示。没有实际向飞书发送内容。" : "已拒绝交付演示，成果保留在当前会话。", request.run, "notice");
  }
  return state;
}

export function restoreDemo(raw: string | null): DemoState {
  if (!raw || raw.length > 2_000_000) return initialDemo();
  try {
    const state = JSON.parse(raw);
    // Validate saved structures before rendering or resuming the local simulation.
    if (state.version !== 1 || !Number.isSafeInteger(state.next) || state.next < 20 || typeof state.selected !== "string") throw new Error();
    const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === "string");
    if (!Array.isArray(state.agents) || !state.agents.length || !state.agents.every((a: DemoAgent) => a &&
      [a.id, a.name, a.role, a.mark, a.tone, a.model, a.memory].every(value => typeof value === "string") && strings(a.tools))) throw new Error();
    const agents = new Set(state.agents.map((a: DemoAgent) => a.id));
    if (!Array.isArray(state.conversations) || !state.conversations.some((c: DemoConversation) => c.id === state.selected) ||
      !state.conversations.every((c: DemoConversation) => c && typeof c.id === "string" && typeof c.title === "string" && typeof c.goal === "string" &&
        ["dm", "group"].includes(c.kind) && strings(c.members) && c.members.length && c.members.every(member => agents.has(member)) && c.members.includes(c.coordinator))) throw new Error();
    const conversations = new Set(state.conversations.map((c: DemoConversation) => c.id));
    if (!Array.isArray(state.runs) || !state.runs.every((r: DemoRun) => r && typeof r.id === "string" && conversations.has(r.conversation) && agents.has(r.agent) &&
      typeof r.title === "string" && ["running", "waiting", "succeeded", "cancelled"].includes(r.state) && Number.isInteger(r.step) && r.step >= 0 && r.step <= 3 &&
      Number.isInteger(r.applied) && strings(r.updates) && r.applied >= 0 && r.applied <= r.updates.length && strings(r.events) && (r.artifact === undefined || typeof r.artifact === "string"))) throw new Error();
    const runs = new Set(state.runs.map((r: DemoRun) => r.id));
    if (!state.runs.every((r: DemoRun) => !r.dependency || runs.has(r.dependency))) throw new Error();
    if (!Array.isArray(state.messages) || !state.messages.every((m: DemoMessage) => m && typeof m.id === "string" && conversations.has(m.conversation) &&
      typeof m.text === "string" && (agents.has(m.sender) || ["notice", "user"].includes(m.sender)) && (!m.run || runs.has(m.run)))) throw new Error();
    if (!Array.isArray(state.requests) || !state.requests.every((r: DemoRequest) => r && typeof r.id === "string" && conversations.has(r.conversation) && runs.has(r.run) && ["pending", "approved", "rejected"].includes(r.state))) throw new Error();
    return { ...state, notice: "" };
  } catch { return initialDemo(); }
}
