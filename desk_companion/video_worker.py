"""yt-dlp 隔离读取：限制站点、字幕大小与重试，不获取视频流。"""
from __future__ import annotations

import html
import http.cookiejar
import json
import math
import re
import shutil
import sys
import urllib.request
from urllib.parse import urlsplit, parse_qs, urlencode

from .video import MAX_SEGMENTS, MAX_TEXT, normalize_url


def clean(value, limit=5000):
    return re.sub(r"<[^>]*>", "", html.unescape(str(value or ""))).strip()[:limit]


def parse_time(text):
    parts = text.replace(",", ".").split(":")
    return sum(float(v) * 60 ** i for i, v in enumerate(reversed(parts)))


def parse_subtitles(text, ext):
    rows = []
    if ext in {"json3", "json"}:
        data = json.loads(text)
        if isinstance(data, dict) and "events" in data:
            for event in data["events"]:
                content = "".join(s.get("utf8", "") for s in event.get("segs", []))
                rows.append({"start": event.get("tStartMs", 0) / 1000, "text": content})
        elif isinstance(data, dict) and isinstance(data.get("body"), list):
            rows = [{"start": r.get("from", 0), "text": r.get("content", "")} for r in data["body"]]
    elif ext in {"vtt", "srt"}:
        for block in re.split(r"\n\s*\n", text.replace("\r", "")):
            lines = block.splitlines()
            for i, line in enumerate(lines):
                match = re.match(r"\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s*-->", line)
                if match:
                    rows.append({"start": parse_time(match[1]), "text": " ".join(lines[i+1:])})
                    break
    result, chars, truncated = [], 0, False
    for row in rows:
        content = re.sub(r"\s+", " ", clean(row.get("text"), 2000)).strip()
        try:
            start = float(row["start"])
        except (TypeError, ValueError):
            continue
        if not content or not math.isfinite(start) or start < 0:
            continue
        # 自动字幕常重复一个滚动片段，合并完全相同的相邻文本。
        if result and result[-1]["text"] == content:
            continue
        if len(result) >= MAX_SEGMENTS or chars + len(content) > MAX_TEXT:
            truncated = True
            break
        result.append({"start": round(start, 3), "text": content})
        chars += len(content)
    result.sort(key=lambda r: r["start"])
    return result, truncated


def select_tracks(info):
    tracks = []
    for automatic, key in ((False, "subtitles"), (True, "automatic_captions")):
        for lang, formats in (info.get(key) or {}).items():
            if lang in {"danmaku", "live_chat"}:
                continue
            # zh-Hans-en 等是机器翻译轨道，优先读原始语言，中文总结交给模型。
            if automatic and re.search(r"-(?:en|zh|ja|ko|de|es|fr)(?:-orig)?$", lang) and not lang.endswith("-orig"):
                continue
            rank = 0 if lang.startswith(("zh", "ai-zh")) else 1 if lang.startswith(("en", "ai-en")) else 2
            for item in formats:
                if item.get("ext") in {"json3", "json", "vtt", "srt"}:
                    tracks.append((rank, automatic, 0 if item["ext"] == "json3" else 1,
                                   lang, item))
    return sorted(tracks, key=lambda r: r[:3])


def safe_caption_url(url, platform):
    p = urlsplit(url)
    if p.scheme != "https" or p.username or p.password or p.port:
        return False
    host = p.hostname or ""
    domains = ("youtube.com", "googlevideo.com") if platform == "YouTube" else ("hdslb.com", "bilibili.com")
    return any(host == d or host.endswith("." + d) for d in domains)


def classify_error(text):
    text = str(text).lower()
    if any(x in text for x in ("sign in", "login", "cookies", "private", "members-only", "age-restricted", "403", "412", "429", "captcha", "bot")):
        return "平台限制访问或需要登录。请在「看板 → 视频读取」打开平台登录窗口，完成登录后点击「使用此登录态」，再重试；登录后仍可能受到平台限流。"
    if any(x in text for x in ("timeout", "timed out", "ssl", "tls", "proxy", "connection", "unreachable", "resolve")):
        return "视频网络连接失败或超时。请在「看板 → 视频读取」检查网络代理设置后重试。"
    return "无法读取这个视频，可能已删除、受地区限制或平台接口变动。请检查链接后重试。"


def caption_bytes(url, platform, headers, cookies, proxy=""):
    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, response_headers, newurl):
            if not safe_caption_url(newurl, platform):
                raise RuntimeError("字幕跳转地址不受支持。")
            return super().redirect_request(req, fp, code, msg, response_headers, newurl)
    if not safe_caption_url(url, platform):
        raise RuntimeError("字幕地址不受支持。")
    handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy}) if proxy else urllib.request.ProxyHandler()
    opener = urllib.request.build_opener(handler, urllib.request.HTTPCookieProcessor(cookies), Redirect())
    with opener.open(urllib.request.Request(url, headers=headers), timeout=12) as response:
        payload = response.read(4_000_001)
        if len(payload) > 4_000_000:
            raise RuntimeError("字幕文件过大。")
        return payload.decode("utf-8-sig")


def resolve_short_url(url, proxy=""):
    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            platform, _ = normalize_url(newurl)
            if platform != "Bilibili":
                raise RuntimeError("短链接跳转地址不受支持。")
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy}) if proxy else urllib.request.ProxyHandler()
    opener = urllib.request.build_opener(handler, Redirect())
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=12) as response:
        _, final = normalize_url(response.url)
        if urlsplit(final).hostname == "b23.tv":
            raise RuntimeError("短链接未能解析，请复制视频网页完整链接。")
        return final


def bilibili_metadata(ydl, url):
    """只读取元数据与字幕接口，不请求播放格式；验证业务状态码。"""
    parsed = urlsplit(url)
    match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10}|av[0-9]+)/?", parsed.path)
    if not match:
        raise RuntimeError("Bilibili 视频信息暂不可读。")
    from yt_dlp.networking import Request
    vid = match[1]
    params = {"bvid": vid} if vid.startswith("BV") else {"aid": vid[2:]}
    headers = {"Referer": url, "User-Agent": "Mozilla/5.0"}
    def api(path, query):
        with ydl.urlopen(Request("https://api.bilibili.com" + path + "?" + urlencode(query), headers=headers)) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise RuntimeError("Bilibili 字幕接口返回过大。")
        value = json.loads(raw)
        if not isinstance(value, dict): raise RuntimeError("Bilibili 接口返回格式异常。")
        return value
    payload = api("/x/web-interface/view", params)
    if payload.get("code") != 0:
        raise RuntimeError("Bilibili 视频信息暂不可读。")
    data = payload["data"]
    part = int(parse_qs(parsed.query).get("p", ["1"])[0])
    pages = data.get("pages") or []
    if part > len(pages):
        raise RuntimeError("所选分 P 不存在。")
    page = pages[part - 1]
    info = {"webpage_url": url, "title": data["title"] + (" · " + page.get("part", "") if len(pages) > 1 else ""),
            "uploader": (data.get("owner") or {}).get("name", ""), "description": data.get("desc", ""),
            "duration": page.get("duration"), "subtitles": {}, "chapters": []}
    try:
        ie = ydl.get_info_extractor("BiliBili")
        query = ie._sign_wbi({"aid": data["aid"], "cid": page["cid"]}, data["bvid"])
        player = api("/x/player/wbi/v2", query)
        code = player.get("code")
        diagnostic = {"stage": "bilibili_subtitle_api", "code": code if type(code) is int else None}
        info["subtitle_diagnostic"] = diagnostic
        if type(code) is not int or code != 0:
            if code == -101:
                info.update(subtitle_status="login_required", subtitle_notice="B站字幕接口要求重新登录。请在视频读取页登录并使用此登录态，再重试。")
                diagnostic["kind"] = "login_required"
            else:
                info.update(subtitle_status="unavailable", subtitle_notice="B站字幕接口暂未成功返回（" + (str(code) if type(code) is int else "状态码缺失") + "），不能判断为视频没有字幕。请稍后重试。")
                diagnostic["kind"] = "platform_restricted" if code in (-352, -403, -412, 429) else "api_error"
            return info
        player_data = player.get("data") or {}
        if player_data.get("need_login_subtitle"):
            info.update(subtitle_status="login_required", subtitle_notice="B站要求登录后才能读取字幕。请在视频读取页登录并使用此登录态，再重试。")
            diagnostic["kind"] = "login_required"
            return info
        subtitle = player_data.get("subtitle")
        if not isinstance(subtitle, dict) or not isinstance(subtitle.get("subtitles"), list):
            raise RuntimeError("Bilibili 字幕接口返回格式异常。")
        for track in subtitle["subtitles"]:
            if not isinstance(track, dict): continue
            language, caption_url = track.get("lan"), track.get("subtitle_url")
            if isinstance(language, str) and language and isinstance(caption_url, str) and caption_url:
                info["subtitles"].setdefault(language, []).append({"ext": "json", "url": caption_url})
        if subtitle["subtitles"] and not info["subtitles"]:
            info.update(subtitle_status="unavailable", subtitle_notice="B站已返回字幕目录，但没有可读取的字幕地址，请稍后重试。")
            diagnostic["kind"] = "invalid_tracks"
            return info
        diagnostic.update(kind="available" if info["subtitles"] else "missing", track_count=sum(len(t) for t in info["subtitles"].values()))
        for chapter in player_data.get("view_points") or []:
            if isinstance(chapter, dict) and type(chapter.get("from")) in (int, float) and math.isfinite(chapter["from"]) and chapter["from"] >= 0:
                info["chapters"].append({"title": chapter.get("content", ""), "start_time": chapter["from"]})
    except Exception as exc:
        info.update(subtitle_status="unavailable", subtitle_notice="B站字幕接口读取失败，不能判断为视频没有字幕。" + classify_error(exc))
        info["subtitle_diagnostic"] = {"stage": "bilibili_subtitle_api", "kind": "request_failed", "error_type": type(exc).__name__}
    return info


def retrieve(url, settings, emit):
    try:
        import yt_dlp
    except ImportError:
        raise RuntimeError("缺少视频读取扩展 yt-dlp。源码运行请安装项目依赖，发布版请更新 tebb。") from None
    platform, url = normalize_url(url)
    if urlsplit(url).hostname == "b23.tv":
        try:
            emit({"status": "正在解析 Bilibili 分享链接。"})
            url = resolve_short_url(url, settings.get("proxy", ""))
        except Exception as exc:
            raise RuntimeError(classify_error(exc)) from None
    warnings = []
    class Logger:
        def debug(self, msg): pass
        def warning(self, msg): warnings.append(str(msg))
        def error(self, msg): pass
    opts = {"quiet": True, "no_warnings": True, "logger": Logger(), "skip_download": True,
            "noplaylist": True, "playlist_items": "1", "writesubtitles": True, "writeautomaticsub": True,
            "ignore_no_formats_error": True, "socket_timeout": 12, "retries": 0,
            "extractor_retries": 0, "cachedir": False,
            "extractor_args": {"youtube": {"skip": ["hls", "dash", "translated_subs"]}}}
    if shutil.which("node"):
        opts["js_runtimes"] = {"node": {"path": shutil.which("node")}}
    if settings.get("proxy"):
        opts["proxy"] = settings["proxy"]
    if settings.get("cookie_file"):
        opts["cookiefile"] = settings["cookie_file"]
    emit({"status": "正在读取视频标题、作者和章节信息。"})
    with yt_dlp.YoutubeDL(opts) as ydl:
        for row in settings.get("cookie_rows", []):
            ydl.cookiejar.set_cookie(http.cookiejar.Cookie(
                version=0, name=row["name"], value=row["value"], port=None, port_specified=False,
                domain=row["domain"], domain_specified=True, domain_initial_dot=row["domain"].startswith("."),
                path=row["path"], path_specified=True, secure=row["secure"], expires=row["expires"] or None,
                discard=not row["expires"], comment=None, comment_url=None,
                rest={"HttpOnly": None} if row["http_only"] else {}))
        try:
            info = bilibili_metadata(ydl, url) if platform == "Bilibili" else ydl.extract_info(url, download=False)
        except Exception as exc:
            raise RuntimeError(classify_error(exc)) from None
        if not isinstance(info, dict) or info.get("_type") in {"playlist", "multi_video"}:
            raise RuntimeError("请提供单个视频或指定分 P 的链接。")
        if not info.get("title") or (str(info["title"]).startswith("youtube video #") and not info.get("description")):
            raise RuntimeError("没有取得有效视频信息，视频可能已删除或平台限制访问。请检查链接和视频网络设置。")
        final_url = info.get("webpage_url") or url
        final_platform, final_url = normalize_url(final_url)
        if final_platform != platform:
            raise RuntimeError("视频跳转地址不受支持。")
        value = {"url": final_url, "title": clean(info.get("title"), 300), "author": clean(info.get("uploader") or info.get("channel"), 200),
                 "description": clean(info.get("description"), 12000), "duration": info.get("duration"),
                 "chapters": [{"title": clean(c.get("title"), 200), "start": c.get("start_time", 0)} for c in (info.get("chapters") or [])[:300]],
                 "segments": [], "truncated": False, "subtitle_status": "missing", "subtitle_language": "", "automatic": False}
        emit({"status": "已获取视频信息，正在读取可用字幕。"})
        if info.get("subtitle_diagnostic"):
            value["subtitle_diagnostic"] = info["subtitle_diagnostic"]
        tracks = select_tracks(info)
        failed, failure_reason = False, ""
        # 至多尝试两份可读字幕，防止平台失败时长期重试。
        for _, automatic, _, language, item in tracks[:2]:
            try:
                raw = item.get("data")
                if raw is None:
                    caption_url = item.get("url", "")
                    if caption_url.startswith("//"):
                        caption_url = "https:" + caption_url
                    if not safe_caption_url(caption_url, platform):
                        raise RuntimeError("字幕地址不受支持。")
                    raw = caption_bytes(caption_url, platform, info.get("http_headers") or {}, ydl.cookiejar, settings.get("proxy", ""))
                if len(raw) > 4_000_000:
                    raise RuntimeError("字幕文件过大。")
                segments, truncated = parse_subtitles(raw, item["ext"])
                if segments:
                    value.update(segments=segments, truncated=truncated, subtitle_status="available",
                                 subtitle_language=language, automatic=automatic or language.startswith("ai-"))
                    break
                failed = True
            except Exception as exc:
                failed = True
                failure_reason = classify_error(exc)
        if value["segments"]:
            value["subtitle_notice"] = ("自动字幕，可能存在识别错误。" if value["automatic"] else "已获取平台字幕。")
            if value["truncated"]:
                value["subtitle_notice"] += "字幕过长，仅保留前段，不能视为全片内容。"
            emit({"status": f"已读取 {len(value['segments'])} 段字幕，正在准备总结来源。"})
        elif info.get("subtitle_status") in {"unavailable", "login_required"} and not failed:
            value.update(subtitle_status=info["subtitle_status"], subtitle_notice=info["subtitle_notice"])
            emit({"status": value["subtitle_notice"]})
        elif failed:
            value.update(subtitle_status="unavailable", subtitle_notice="字幕读取失败。" + failure_reason + " 当前只能介绍标题、简介和章节。")
            emit({"status": "字幕未能读取，已保留视频信息。"})
        elif any("login" in w.lower() or "logged in" in w.lower() for w in warnings):
            value.update(subtitle_status="login_required", subtitle_notice="平台要求登录才能读取字幕。请在「看板 → 视频读取」登录并使用此登录态；当前只能介绍标题、简介和章节。")
            emit({"status": "平台要求登录读取字幕，已保留视频信息。"})
        else:
            value["subtitle_notice"] = "没有可用的平台字幕。当前只能介绍标题、简介和章节，无法给出全片总结。"
            emit({"status": "未发现可用字幕，已保留视频信息。"})
        value["segment_count"] = len(value["segments"])
        value["text_chars"] = sum(len(s["text"]) for s in value["segments"])
        return value


def main():
    def emit(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)
    try:
        request = json.loads(sys.stdin.readline())
        emit({"result": retrieve(request["url"], request.get("settings", {}), emit)})
    except Exception as exc:
        # 不将第三方 URL、cookie 路径、代理或堆栈送回模型和飞书。
        text = str(exc) if isinstance(exc, RuntimeError) else "视频读取失败，请检查链接和网络设置后重试。"
        emit({"error": text})


if __name__ == "__main__":
    main()
