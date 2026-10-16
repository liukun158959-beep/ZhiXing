"""Card 2.0：遵循 lark-im 卡片工作流；状态背景块 + 正文，单卡持续更新。"""
import hashlib
import json
import time
from .feishu_tools import _run_lark


def card(title, status, answer, streaming=False, failed=False):
    color = "orange" if failed else "blue"
    return {"schema": "2.0", "config": {"update_multi": True, "width_mode": "default", "enable_forward": False,
            "streaming_mode": streaming, "summary": {"content": title + " · " + status[:60]},
            **({"streaming_config": {"print_frequency_ms": {"default": 70}, "print_step": {"default": 1}, "print_strategy": "fast"}} if streaming else {})},
            "header": {"title": {"tag": "plain_text", "content": title}, "template": color},
            "body": {"direction": "vertical", "padding": "12px 12px 20px 12px", "elements": [
                {"tag": "column_set", "flex_mode": "none", "margin": "0px 0px 12px 0px", "columns": [
                    {"tag": "column", "width": "weighted", "weight": 1, "background_style": color + "-50", "padding": "12px",
                     "elements": [{"tag": "markdown", "element_id": "task_status", "content": "**" + status + "**"}]}]},
                {"tag": "markdown", "element_id": "task_answer", "content": answer or "正在准备回答…"}]}}


def api(profile, method, path, body):
    raw = _run_lark(["--profile", profile, "api", method, path, "--as", "bot", "--data", "-"],
                    timeout=20, stdin=json.dumps(body, ensure_ascii=False))
    value = json.loads(raw)
    if value.get("ok") is False:
        raise RuntimeError("飞书卡片操作失败，请检查 cardkit:card:write 和机器人消息权限。")
    data = value.get("data", value)
    if isinstance(data, dict) and data.get("code", 0) != 0:
        raise RuntimeError("飞书卡片操作未确认成功。")
    return data.get("data", data) if isinstance(data, dict) else data


class CardReply:
    def __init__(self, profile, message_id, owner_id, key, saved=None, persist=None):
        self.profile, self.message_id, self.owner_id, self.key = profile, message_id, owner_id, key
        self.saved = saved or {}
        self.card_id = self.saved.get("card_id", "")
        self.message = self.saved.get("reply_id", "")
        self.sequence = self.saved.get("card_seq", 0)
        self.persist = persist or (lambda **kw: None)

    def _key(self, suffix):
        return "dc-" + hashlib.sha256((self.key + suffix).encode()).hexdigest()[:40]

    def start(self, title="tebb · 任务回复", status="已收到。正在准备处理。", answer=""):
        if not self.card_id:
            value = api(self.profile, "POST", "/open-apis/cardkit/v1/cards", {"type": "card_json",
                        "data": json.dumps(card(title, status, answer, True), ensure_ascii=False)})
            self.card_id = str(value["card_id"])
            self.persist(card_id=self.card_id)
        if not self.message:
            value = self.send({"type": "card", "data": {"card_id": self.card_id}}, "interactive", self._key("card"))
            self.message = str(value.get("message_id") or "")
            if not self.message:
                raise RuntimeError("卡片发送没有返回消息 ID。")
            self.persist(reply_id=self.message)

    def send(self, content, msg_type, key):
        if self.message_id.startswith("om_"):
            command = ["--profile", self.profile, "im", "+messages-reply", "--as", "bot", "--message-id", self.message_id]
        else:
            command = ["--profile", self.profile, "im", "+messages-send", "--as", "bot", "--user-id", self.owner_id]
        command += ["--msg-type", msg_type, "--content", json.dumps(content, ensure_ascii=False), "--idempotency-key", key]
        value = json.loads(_run_lark(command, timeout=20))
        if value.get("ok") is not True:
            raise RuntimeError("飞书消息未确认发送。")
        data = value.get("data") or {}
        return data.get("data", data)

    def operation(self, method, suffix, body):
        # 先持久化序号；响应丢失后重试也只递增，不倒退。
        self.sequence += 1
        self.persist(card_seq=self.sequence)
        body.update(sequence=self.sequence, uuid=self._key(str(self.sequence)))
        last = None
        for _ in range(2):
            try:
                return api(self.profile, method, "/open-apis/cardkit/v1/cards/" + self.card_id + suffix, body)
            except Exception as exc:
                last = exc
        raise last

    def update(self, status, answer):
        self.operation("PUT", "/elements/task_status/content", {"content": "**" + status + "**"})
        # 30KB 左右卡片限制留出结构空间，完整正文仍保留在桌宠和最终补充消息。
        self.operation("PUT", "/elements/task_answer/content", {"content": preview(answer)})

    def finish(self, status, answer, failed=False, title="tebb · 任务回复"):
        self.operation("PATCH", "/settings", {"settings": json.dumps({"config": {"streaming_mode": False}})})
        self.operation("PUT", "", {"card": {"type": "card_json", "data": json.dumps(card(title, status, preview(answer), failed=failed), ensure_ascii=False)}})


def preview(text):
    value = (text or "正在准备回答…").encode("utf-8")
    if len(value) <= 22000:
        return value.decode("utf-8")
    return value[:21500].decode("utf-8", errors="ignore") + "\n\n完整内容见桌宠监控台或后续分段回复。"


def memory_pages(session_id):
    """读取已有事实与摘要；没有模型调用，不以聊天原文替代摘要。"""
    from .facts import read_facts
    from .context_pack import context_view
    facts = read_facts()
    summary = context_view(session_id, "")['summary']
    text = "**长期事实与偏好**\n" + ("\n".join("- " + f["text"] for f in facts) or "尚无长期记忆。")
    text += "\n\n**当前会话摘要**\n" + (summary or "这段会话还没有生成压缩摘要。")
    return [text[i:i + 6000] for i in range(0, len(text), 6000)] or [text]
