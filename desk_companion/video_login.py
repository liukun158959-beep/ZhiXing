"""tebb 专用视频窗口的登录快照；Windows 当前用户 DPAPI 加密，不读取外部浏览器。"""
from __future__ import annotations

import base64
import json
import re
import time

from .paths import data_root

DOMAINS = {"Bilibili": ("bilibili.com",), "YouTube": ("youtube.com", "google.com")}
AUTH = {"Bilibili": {"SESSDATA"}, "YouTube": {"SID", "SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"}}


def path(platform):
    if platform not in DOMAINS:
        raise ValueError("请选择 Bilibili 或 YouTube。")
    return data_root() / "memory" / "video_login" / (platform.lower() + ".json")


def valid_rows(platform, cookies):
    path(platform)
    if not isinstance(cookies, list) or len(cookies) > 500:
        raise ValueError("视频登录信息格式不正确。")
    rows = []
    for row in cookies:
        if not isinstance(row, dict):
            raise ValueError("视频登录信息格式不正确。")
        domain = row.get("domain", "")
        name, value, cookie_path = row.get("name"), row.get("value"), row.get("path", "/")
        expiry = row.get("expires", 0)
        if not isinstance(domain, str) or not re.fullmatch(r"\.?[a-z0-9.-]+", domain) or not any(domain.lstrip(".") == d or domain.lstrip(".").endswith("." + d) for d in DOMAINS[platform]):
            raise ValueError("视频登录信息包含不属于该平台的域名。")
        if (not all(isinstance(v, str) for v in (name, value, cookie_path)) or not name
                or not cookie_path.startswith("/") or any(c in name + value + cookie_path for c in "\r\n\t\x00")
                or len(name) > 200 or len(value) > 20000 or len(cookie_path) > 2000
                or type(expiry) is not int or expiry < 0 or expiry > 253402300799
                or type(row.get("secure", False)) is not bool or type(row.get("http_only", False)) is not bool):
            raise ValueError("视频登录信息格式不正确。")
        if not expiry or expiry > time.time():
            rows.append({"domain": domain, "name": name, "value": value, "path": cookie_path,
                         "expires": expiry, "secure": row.get("secure", False), "http_only": row.get("http_only", False)})
    if len(json.dumps(rows).encode()) > 500000:
        raise ValueError("视频登录信息过大。")
    return rows


def _read(platform):
    import win32crypt
    file = path(platform)
    if not file.exists():
        return None
    try:
        value = json.loads(file.read_text("utf-8"))
        _, raw = win32crypt.CryptUnprotectData(base64.b64decode(value["encrypted"]), None, None, None, 0)
        return {"saved_at": value["saved_at"], "cookies": valid_rows(platform, json.loads(raw))}
    except Exception:
        raise ValueError("本机视频登录态无法解密，请清除后重新登录。") from None


def status():
    items = []
    for platform in DOMAINS:
        try:
            value = _read(platform)
            usable = bool(value and any(row["name"] in AUTH[platform] for row in value["cookies"]))
            items.append({"platform": platform, "state": "saved" if usable else "expired" if value else "missing",
                          "saved_at": value["saved_at"] if value else None})
        except ValueError as exc:
            items.append({"platform": platform, "state": "error", "error": str(exc)})
    return {"items": items}


def save(platform, cookies):
    import win32crypt
    from .video import atomic_write
    rows = valid_rows(platform, cookies)
    if not any(row["name"] in AUTH[platform] for row in rows):
        raise ValueError("尚未检测到登录信息。请先在视频窗口完成登录，再点击「使用此登录态」。")
    raw = json.dumps(rows).encode()
    encrypted = win32crypt.CryptProtectData(raw, "ZhiXing video login", None, None, None, 0)
    atomic_write(path(platform), {"saved_at": time.time(), "encrypted": base64.b64encode(encrypted).decode()})
    return {"ok": True, **status()}


def clear(platform):
    path(platform).unlink(missing_ok=True)
    return {"ok": True, **status()}


def cookies(platform):
    value = _read(platform)
    if value and any(row["name"] in AUTH[platform] for row in value["cookies"]):
        return value["cookies"]
    return []
