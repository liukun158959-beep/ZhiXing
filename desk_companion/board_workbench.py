"""看板对话工作台：session、输入点选、复盘写入飞书。"""
from __future__ import annotations

import json
import os

from .memory import list_chat, list_sessions
from .state import new_session_id

CLI_CHIPS = (
    ("get_today_agenda", "今日日程"),
    ("get_open_tasks", "未完成待办"),
    ("github_status", "GitHub 状态"),
    ("github_recent", "GitHub 近况"),
    ("github_roadmap", "GitHub 路线图"),
    ("web_search", "联网搜索"),
    ("read_video", "视频信息与字幕"),
    ("read_video_transcript", "视频字幕原文"),
    ("execute_command", "沙箱执行命令"),
    ("read_terminal_output", "命令执行记录"),
)


class BoardWorkbench:
    def board_composer_options(self) -> dict:
        from .skill_catalog import list_skills

        try:
            skills = [
                {"id": item["id"], "label": item["id"], "description": item["description"]}
                for item in list_skills()
            ]
        except Exception as extra:
            return {"ok": False, "error": str(extra)}
        github = {"ok": True, "items": []}
        try:
            from .github import list_owned_repos

            github = {
                "ok": True,
                "items": [
                    {"id": row["full_name"], "label": row["full_name"]}
                    for row in list_owned_repos()
                ],
            }
        except Exception as extra:
            github = {"ok": False, "error": str(extra), "items": []}
        return {
            "ok": True,
            "skills": skills,
            "cli": [{"id": key, "label": label} for key, label in CLI_CHIPS],
            "github": github,
        }

    def new_chat_session(self) -> dict:
        try:
            if self._agent_running:
                raise RuntimeError("助手正在回复，等这句说完再开新对话。")
            current = list_chat(self.state.session_id)
            if current:
                self.state.session_id = new_session_id()
                self.state.save()
            self._reload_session_views()
            return {"ok": True, "session_id": self.state.session_id}
        except Exception as extra:
            return {"ok": False, "error": str(extra)}

    def switch_chat_session(self, session_id: str) -> dict:
        try:
            if type(session_id) is not str or not session_id.strip():
                raise RuntimeError("切换对话需要 session_id。")
            sid = session_id.strip()
            known = {row["id"] for row in list_sessions()}
            if sid != self.state.session_id and sid not in known:
                raise RuntimeError("没有这条对话线程。")
            if self._agent_running:
                raise RuntimeError("助手正在回复，等这句说完再切换对话。")
            self.state.session_id = sid
            self.state.save()
            self._reload_session_views()
            return {"ok": True, "session_id": sid, "items": list_chat(sid)}
        except Exception as extra:
            return {"ok": False, "error": str(extra)}

    def _reload_session_views(self) -> None:
        rows = list_chat(self.state.session_id)
        if self.agent is not None:
            self.agent.memory.clear()
        self._eval_bubble("load_history", rows=rows)
        self._eval_board(
            "load_thread",
            items=rows,
            session_id=self.state.session_id,
            sessions=list_sessions(),
        )

    def list_mcp_tools(self) -> dict:
        from .mcp_client import list_mcp_menu

        return list_mcp_menu()

    def list_feishu_docs(self) -> dict:
        from .feishu_docs import list_my_docx
        from .wiki_connection import catalog, load_settings, enrich_catalog
        items, errors = [], []
        for get in (list_my_docx, catalog):
            try:
                items.extend(get())
            except Exception as extra:
                items.extend(getattr(extra, 'items', []))
                errors.append(str(extra))
        unique = {item["token"]: item for item in items}
        grouped = enrich_catalog(list(unique.values())) if unique else []
        return {"ok": bool(items) or not errors, "items": grouped,
                "error": "\n".join(errors), "wiki_connected": bool(load_settings().get("wiki_url"))}

    def write_week_review_doc(self, payload: dict) -> dict:
        from .board_data import load_today_snapshot, save_today_fields
        from .feishu_docs import create_or_overwrite_markdown

        if not isinstance(payload, dict):
            return {"ok": False, "error": "写入参数必须是对象。"}
        try:
            snap = load_today_snapshot(refresh=False)
            markdown = (snap.get("summary") or "").strip()
            result = create_or_overwrite_markdown(
                markdown=markdown,
                doc=str(payload.get("doc") or ""),
                title=str(payload.get("title") or ""),
            )
            url = result.get("url") or ""
            if url:
                snap = save_today_fields(doc_url=url)
                if "新建" in str(result.get("message") or ""):
                    os.startfile(url)
            return {"ok": True, **snap, **result}
        except Exception as extra:
            return {"ok": False, "error": str(extra)}

    def list_automation_jobs(self, seen: bool = False) -> dict:
        try:
            if seen:
                return self.automation.seen()
            return self.automation.snapshot()
        except Exception as extra:
            return {"ok": False, "error": str(extra)}

    def save_automation_job(self, payload: dict) -> dict:
        from .automation import upsert_job

        try:
            upsert_job(payload)
            return self.automation.snapshot()
        except Exception as extra:
            return {"ok": False, "error": str(extra)}

    def delete_automation_job(self, job_id: str) -> dict:
        from .automation import delete_job

        try:
            self.automation.drop_queued(str(job_id or ""))
            delete_job(str(job_id or ""))
            return self.automation.snapshot()
        except Exception as extra:
            return {"ok": False, "error": str(extra)}

    def run_automation_job(self, job_id: str) -> dict:
        try:
            return self.automation.run_now(str(job_id or ""))
        except Exception as extra:
            return {"ok": False, "error": str(extra)}

    def send_board_chat(self, text: str, chips: dict | None = None) -> dict:
        if isinstance(chips, str):
            try:
                chips = json.loads(chips)
            except json.JSONDecodeError as extra:
                return {"ok": False, "error": f"点选参数不是合法 JSON。{extra}"}
        if chips is None:
            chips = {}
        if not isinstance(chips, dict):
            return {"ok": False, "error": "点选参数必须是对象。"}
        if self.pet is None:
            return {"ok": False, "error": "宠物还没就绪。"}
        if self.pet.busy or self._agent_running:
            return {"ok": False, "error": "助手正在回复。"}
        try:
            retro = chips.get("retro")
            if retro:
                raise RuntimeError(
                    "复盘请用自动化任务「周复盘」生成或写入，不要和聊天混在一条发送里。"
                )
            message = self._compose_turn(text, chips)
            self.ui(lambda: self.send_chat(message, from_board=True))
            return {"ok": True}
        except Exception as extra:
            return {"ok": False, "error": str(extra)}


    def _compose_turn(self, text: str, chips: dict) -> str:
        body = (text or "").strip()
        skills = chips.get("skills") or []
        cli = chips.get("cli") or []
        github = chips.get("github") or ""
        docs = chips.get("docs") or []
        mcp = chips.get("mcp") or []
        attachments = chips.get("attachments") or []
        extra_keys = set(chips) - {"skills", "cli", "github", "retro", "docs", "mcp", "attachments"}
        if extra_keys:
            raise RuntimeError(f"不认识的点选：{', '.join(sorted(extra_keys))}。")
        if skills and (
            type(skills) is not list
            or any(type(x) is not str or not x.strip() for x in skills)
        ):
            raise RuntimeError("技能点选必须是非空字符串列表。")
        if cli and (
            type(cli) is not list or any(type(x) is not str or not x.strip() for x in cli)
        ):
            raise RuntimeError("CLI 点选必须是非空字符串列表。")
        if github and type(github) is not str:
            raise RuntimeError("仓库点选必须是字符串。")
        allowed_cli = {key for key, _label in CLI_CHIPS}
        for name in cli:
            if name not in allowed_cli:
                raise RuntimeError(f"没有 CLI 工具 {name!r}。")
        if any(name in NEED_REPO_TOOLS for name in cli) and not str(github).strip():
            raise RuntimeError("选了 GitHub 近况或路线图时必须同时选一个已列出的仓库。")
        _check_doc_picks(docs)
        _check_mcp_picks(mcp)
        if type(attachments) is not list or len(attachments) > 50 or any(not isinstance(x, str) for x in attachments):
            raise RuntimeError("本地附件必须为最多 50 个资料编号。")
        if not body and not skills and not cli and not github and not docs and not mcp and not attachments:
            raise RuntimeError("输入框是空的。")
        if not skills and not cli and not github and not docs and not mcp and not attachments:
            return body
        lines = ["【本轮指定】"]
        for name in skills:
            lines.append(
                f"- 技能 {name.strip()} 的正文已附在本轮【技能正文】，按正文执行，不要再调用 read_skill。"
            )
        for name in cli:
            lines.append(f"- 必须调用工具 {name.strip()}")
        if str(github).strip():
            lines.append(
                f"- GitHub 仓库 {github.strip()}；github_recent / github_roadmap 必须用这个仓库"
            )
        for doc in docs:
            lines.append(
                f"- 飞书文档《{_doc_title_link(doc)}》的正文已附在本轮【文档正文】，"
                "只根据正文回答，不要编文档里没有的内容。"
            )
        if attachments:
            from .local_sources import get
            for ident in attachments:
                source = get(ident)
                lines.append(f'- 本地附件《{source["name"]}》（编号 {ident}），资料见本轮【本地附件】。')
        from .mcp_client import mcp_fn_name

        for item in mcp:
            lines.append(f"- 必须调用工具 {mcp_fn_name(item['server'].strip(), item['tool'].strip())}")
        prefix = "\n".join(lines)
        if body:
            return prefix + "\n\n" + body
        return prefix + "\n\n按上面的指定执行。"


def _doc_title_link(doc: dict) -> str:
    """标题写成超链接。没有 http(s) 地址就只留标题，不编一个打不开的网址。"""
    label = doc["label"].strip().replace("[", "［").replace("]", "］")
    ident = doc["id"].strip()
    if not _openable_doc_url(ident):
        return label
    href = ident.replace("(", "%28").replace(")", "%29")
    return f"[{label}]({href})"


def _openable_doc_url(url: str) -> bool:
    if not url or len(url) > 2000 or any(ch.isspace() for ch in url):
        return False
    lower = url.lower()
    if not (lower.startswith("https://") or lower.startswith("http://")):
        return False
    rest = url.split("://", 1)[1]
    host = rest.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    return bool(host) and "@" not in host


def _check_doc_picks(docs) -> None:
    if not docs:
        return
    if type(docs) is not list:
        raise RuntimeError("飞书文档点选必须是列表。")
    for item in docs:
        label = item.get("label") if isinstance(item, dict) else None
        ident = item.get("id") if isinstance(item, dict) else None
        if (
            not isinstance(item, dict)
            or set(item) - {"id", "label"}
            or type(ident) is not str
            or not ident.strip()
            or any(ch.isspace() for ch in ident)
            or type(label) is not str
            or not label.strip()
        ):
            raise RuntimeError("飞书文档点选必须带文档地址和标题。")


def _check_mcp_picks(mcp) -> None:
    if not mcp:
        return
    if type(mcp) is not list:
        raise RuntimeError("MCP 点选必须是列表。")
    for item in mcp:
        server = item.get("server") if isinstance(item, dict) else None
        tool = item.get("tool") if isinstance(item, dict) else None
        label = item.get("label") if isinstance(item, dict) else None
        if (
            not isinstance(item, dict)
            or set(item) - {"server", "tool", "label"}
            or type(server) is not str
            or not server.strip()
            or any(ch.isspace() for ch in server)
            or type(tool) is not str
            or not tool.strip()
            or any(ch.isspace() for ch in tool)
            or (label is not None and (type(label) is not str or not label.strip()))
        ):
            raise RuntimeError("MCP 点选必须带服务器名和工具名。")
