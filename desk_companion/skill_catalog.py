"""桌宠技能库：只读 skills/*/SKILL.md。不是插件市场。"""
from __future__ import annotations

from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"


def list_skills() -> list[dict]:
    if not SKILLS_DIR.is_dir():
        raise RuntimeError(
            f"没有技能目录 {SKILLS_DIR}。在 desk-companion/skills/<名>/SKILL.md 放入技能。"
        )
    names = sorted(p.name for p in SKILLS_DIR.iterdir() if p.is_dir())
    if not names:
        raise RuntimeError(f"{SKILLS_DIR} 里没有技能文件夹。")
    out = []
    for name in names:
        meta, body = _read_skill_file(name)
        out.append(
            {
                "id": meta["name"],
                "description": meta["description"],
                "body": body,
                "path": str(SKILLS_DIR / name / "SKILL.md"),
            }
        )
    return out


def skill_turn_block(names: list) -> str:
    """点名的技能正文。只拼进发给模型的这一轮，不写入对话记录。"""
    if type(names) is not list or not names:
        raise RuntimeError("技能点选必须是非空字符串列表。")
    if any(type(name) is not str or not name.strip() for name in names):
        raise RuntimeError("技能点选必须是非空字符串列表。")
    parts = ["【技能正文】"]
    for name in names:
        snap = read_skill(name.strip())
        parts.append(f"# {snap['id']}\n{snap['description']}\n\n{snap['body']}")
    parts.append("以上就是技能正文，按正文执行，不要再调用 read_skill。")
    return "\n\n".join(parts)


def read_skill(name: str) -> dict:
    if type(name) is not str or not name.strip():
        raise RuntimeError("技能名必须是非空字符串。")
    meta, body = _read_skill_file(name.strip())
    return {
        "id": meta["name"],
        "description": meta["description"],
        "body": body,
        "path": str(SKILLS_DIR / name.strip() / "SKILL.md"),
    }


def _read_skill_file(name: str) -> tuple[dict, str]:
    import re
    if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name): raise ValueError("技能名称无效")
    path = SKILLS_DIR / name / "SKILL.md"
    if not path.is_file():
        raise RuntimeError(
                f"没有技能 {name}。打开看板对话「技能」子界面查看已有技能，或检查 {path}。"
        )
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise RuntimeError(f"{path} 必须以 YAML frontmatter 开头。")
    rest = text.split("\n", 1)[1] if "\n" in text else ""
    end = rest.find("\n---")
    if end < 0:
        raise RuntimeError(f"{path} 的 frontmatter 没有结束 ---。")
    raw_meta = rest[:end]
    body = rest[end + 4 :].lstrip("\n")
    meta = {}
    for line in raw_meta.splitlines():
        if ":" not in line or line.startswith(" "):
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip().strip('"').strip("'")
    if meta.get("name") != name:
        raise RuntimeError(f"{path} 的 name 必须是 {name!r}，与文件夹一致。")
    if type(meta.get("description")) is not str or not meta["description"].strip():
        raise RuntimeError(f"{path} 缺少 description。")
    if not body.strip():
        raise RuntimeError(f"{path} 正文为空。")
    return meta, body
