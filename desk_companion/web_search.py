"""联网搜索。走当前设置里的 API 地址 /v1/tool/search，和对话同一把 Key。"""
from __future__ import annotations

import json
import http.client
import socket
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode
import xml.etree.ElementTree as ET

QUERY_MAX = 200
SOURCE_LIMIT = 5
TIMEOUT_S = 30
REQUEST_BUDGET_S = 60


class SearchFailure(RuntimeError):
    def __init__(self, message, *, category="unknown", stage="unknown", http_status=None):
        super().__init__(message)
        self.category=category;self.stage=stage;self.http_status=http_status

    def diagnostic(self):
        return dict(category=self.category,stage=self.stage,http_status=self.http_status)


class RetryableSearchError(SearchFailure):
    """仅用于网络或搜索服务的临时故障。"""


class SearchUnavailable(SearchFailure):
    """当前模型提供商没有搜索端点，可使用公开备用搜索。"""

SEARCH_HINT = (
    "联网搜索走当前模型的 API。"
    "打开主窗「设置」，API 地址要以 /v1 结尾，Key 用现在这把。"
)


def search_endpoint(base_url: str) -> str:
    url = (base_url or "").strip().rstrip("/")
    if not url.endswith("/v1"):
        raise RuntimeError(SEARCH_HINT)
    return url + "/tool/search"


def format_search(payload: dict) -> str:
    """收成标题、摘要和链接。没有可用链接就失败。"""
    if not isinstance(payload, dict):
        raise RuntimeError("联网搜索返回不是对象。不要编。")
    if payload.get("error") and "results" not in payload:
        raise RuntimeError(f"联网搜索失败：{payload.get('error')} 不要编。")
    rows = payload.get("results")
    if type(rows) is not list or not rows:
        message = str(payload.get("message") or "").strip()
        if message:
            raise RuntimeError(f"联网搜索失败：{message} 不要编。")
        raise RuntimeError("没有搜到结果。不要编。")
    lines = ["来源："]
    if payload.get("provider"):
        lines.append("搜索渠道："+str(payload["provider"]))
    if payload.get("fallback_reason"):
        lines.append("主搜索未完成，使用备用来源："+str(payload["fallback_reason"]))
        lines.append("备用 RSS 只返回候选链接，可能跑题；必须核对实体、主题与日期，无关结果应说明证据不足，不能视为问题已解决。")
    kept = 0
    skipped = 0
    for row in rows:
        if kept >= SOURCE_LIMIT:
            break
        if not isinstance(row, dict):
            skipped += 1
            continue
        title = str(row.get("title") or "").strip()
        link = str(row.get("link") or "").strip()
        if not title or not (link.startswith("https://") or link.startswith("http://")):
            skipped += 1
            continue
        kept += 1
        lines.append(f"{kept}. {title}")
        lines.append(link)
        snippet = str(row.get("snippet") or "").strip()
        if len(snippet) > 300:
            snippet = snippet[:300] + "（摘要后面没带上）"
        if snippet:
            lines.append(snippet)
        published = str(row.get("published_date") or "").strip()
        if published:
            lines.append(f"日期：{published}")
    if kept == 0:
        raise RuntimeError("搜索结果没有可用的标题和链接。不要编。")
    extra = len(rows) - kept - skipped
    if extra > 0:
        lines.append(f"还有 {extra} 条来源没列出。")
    if skipped:
        lines.append(f"有 {skipped} 条缺少标题或链接，没有列入。")
    lines.append("本次搜索只提供标题、摘要和链接，未读取来源全文。引用本次搜索时只用这些内容支持的结论，对不上就不要采用；与视频字幕等其他来源分开标明。")
    return "\n".join(lines)


def web_search(args: dict, *, on_status=None) -> str:
    cfg = {}
    try:
        if not isinstance(args, dict):
            raise RuntimeError("搜索参数不是对象，没有搜索。不要编。")
        query = args.get("query")
        if type(query) is not str or not query.strip():
            raise RuntimeError("搜索词是空的，没有搜索。不要编。")
        text = query.strip()
        if len(text) > QUERY_MAX:
            raise RuntimeError(f"搜索词超过 {QUERY_MAX} 字，没有搜索。不要编。")
        from .envconf import require_llm_env

        cfg = require_llm_env()
        endpoint = search_endpoint(cfg["ATLAS_BASE_URL"])
        payload = search_sources(endpoint, cfg["ATLAS_API_KEY"], text, on_status=on_status)
        return format_search(payload)
    except Exception as exc:
        message = str(exc).strip() or "联网搜索失败。"
        if cfg.get("ATLAS_API_KEY"):
            message = message.replace(cfg["ATLAS_API_KEY"], "[密钥已隐藏]")
        if "不要编" not in message:
            message += " 不要编。"
        # Atlas 根据异常记录真实失败，仍会把错误交给模型解释。
        raise RuntimeError(message) from None


WEB_SEARCH_SPEC = {
    "func": web_search,
    "name": "web_search",
    "description": (
        "搜索互联网上的实时信息。用户问天气、新闻、现在、最新、网上才有的事，"
        "或这一轮指定必须调用 web_search 时使用。"
        "也用于读取视频字幕后，核实关键争议或时效性事实，优先搜索官方资料；不能代替读取视频。"
        "query 是一句搜索词，不超过 200 字。"
        "只根据返回的来源标题、摘要和链接回答。失败或没有结果就原样说明，不要编。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "搜索词，不超过 200 字"},
        },
        "required": ["query"],
    },
    "isReadOnly": True,
    "retry_max": 0,
}


def _post(endpoint: str, api_key: str, query: str, *, on_status=None,
          timeout_s=TIMEOUT_S, budget_s=REQUEST_BUDGET_S, on_attempt=None) -> dict:
    deadline = time.monotonic() + budget_s
    for attempt in range(2):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RetryableSearchError("联网搜索预算已耗尽。",category="timeout",stage="budget")
        started=time.monotonic() if on_attempt else 0
        try:
            result=_post_once(endpoint, api_key, query, min(timeout_s, remaining))
            if on_attempt:on_attempt(dict(provider="model-api",attempt=attempt+1,ok=True,elapsed_ms=int((time.monotonic()-started)*1000)))
            return result
        except RuntimeError as exc:
            if on_attempt:
                diagnostic=exc.diagnostic() if isinstance(exc,SearchFailure) else dict(category="response_error",stage="response")
                on_attempt(dict(provider="model-api",attempt=attempt+1,ok=False,elapsed_ms=int((time.monotonic()-started)*1000),**diagnostic))
            if not isinstance(exc,RetryableSearchError):raise
            if attempt == 1 or deadline - time.monotonic() <= .5:
                raise
            if on_status:
                on_status("联网搜索遇到临时网络错误，正在重试一次。")
            time.sleep(.5)
    raise RuntimeError("联网搜索失败。")


def search_sources(endpoint: str, api_key: str, query: str, *, on_status=None) -> dict:
    """At most two short primary attempts, then one unauthenticated RSS fallback.

    Authentication/certificate/configuration errors are never hidden by fallback.
    No model credential, cookies or headers are sent to Bing.
    """
    started = time.monotonic()
    attempts=[]
    try:
        payload = _post(endpoint, api_key, query, on_status=on_status, timeout_s=12, budget_s=25,on_attempt=attempts.append)
        format_search(payload)  # A 200 response alone is not evidence of success.
        return {**payload, "provider": "model-api", "attempts":attempts,"elapsed_ms": int((time.monotonic()-started)*1000)}
    except (RetryableSearchError, SearchUnavailable) as exc:
        reason = str(exc).replace(api_key, "[密钥已隐藏]")[:300] if api_key else str(exc)[:300]
        primary_failure=exc.diagnostic()
    if on_status:
        on_status("主搜索暂不可用，正在使用公共 Bing 备用搜索。")
    try:
        fallback_started=time.monotonic()
        payload = _bing_search(query)
        format_search(payload)
    except Exception:
        attempts.append(dict(provider="bing-rss",attempt=1,ok=False,elapsed_ms=int((time.monotonic()-fallback_started)*1000)))
        error=RetryableSearchError("主搜索未完成："+reason+"；公共 Bing 备用搜索也未取得来源。",category="all_providers_failed",stage="fallback")
        error.attempts=attempts;error.primary_failure=primary_failure
        raise error from None
    attempts.append(dict(provider="bing-rss",attempt=1,ok=True,elapsed_ms=int((time.monotonic()-fallback_started)*1000)))
    return {**payload, "provider": "bing-rss", "fallback_reason": reason,"primary_failure":primary_failure,"attempts":attempts,
            "elapsed_ms": int((time.monotonic()-started)*1000)}


def _bing_search(query: str) -> dict:
    request = urllib.request.Request("https://www.bing.com/search?"+urlencode({"format":"rss", "q":query}),
        headers={"User-Agent":"tebb-research/0.2", "Accept":"application/rss+xml, application/xml, text/xml"})
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read(512001)
        if len(raw)>512000: raise RuntimeError("备用搜索响应过大")
    root = ET.fromstring(raw)
    rows = [dict(title=item.findtext("title", ""), link=item.findtext("link", ""),
                 snippet=item.findtext("description", ""), published_date=item.findtext("pubDate", ""))
            for item in root.findall("./channel/item")[:SOURCE_LIMIT]]
    return {"results":rows}


def _temporary_message(message: str) -> bool:
    text = message.lower()
    if any(term in text for term in ("certificate", "cert_verify", "invalid_client", "unauthorized", "forbidden")):
        return False
    return any(term in text for term in ("timeout", "timed out", "超时", "connection reset", "temporarily unavailable",
        "unexpected_eof_while_reading", "eof occurred in violation", "remote end closed connection", "connection aborted", "broken pipe"))


def _post_once(endpoint: str, api_key: str, query: str, timeout: float) -> dict:
    body = {
        "crawl_results": 0,
        "max_results": SOURCE_LIMIT,
        "query": query,
        "search_service": "google",
    }
    raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=raw,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    stage="connect_or_response_headers"
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            stage="response_body"
            raw = response.read(1000001)
            if len(raw)>1000000: raise RuntimeError("搜索响应过大。")
            text = raw.decode("utf-8")
    except TimeoutError as exc:
        raise RetryableSearchError("联网搜索超时。恢复：稍后重试。",category="timeout",stage=stage) from exc
    except urllib.error.HTTPError as exc:
        detail = exc.read(10000).decode("utf-8", errors="replace")
        error = (SearchUnavailable if exc.code in {404, 405, 501} else
                 RetryableSearchError if exc.code in {408, 429, 500, 502, 503, 504} else SearchFailure)
        raise error(_http_error(exc.code, detail),category="http_error",stage="response_headers",http_status=exc.code) from exc
    except urllib.error.URLError as exc:
        reason = exc.reason
        certificate=isinstance(reason,ssl.SSLCertVerificationError)
        eof=isinstance(reason,ssl.SSLEOFError) or "unexpected_eof_while_reading" in str(reason).lower()
        temporary = not certificate and (
            isinstance(reason, (TimeoutError, ConnectionResetError, socket.gaierror,ssl.SSLEOFError)) or _temporary_message(str(reason)))
        # TLS 握手超时可能是 TimeoutError 或文本；证书校验错误不能通过重试掩盖。
        error = RetryableSearchError if temporary else SearchFailure
        category="tls_certificate" if certificate else "tls_eof" if eof else "dns" if isinstance(reason,socket.gaierror) else "connection_error"
        phase=("response_body" if stage=="response_body" else "tls_handshake") if certificate or eof else "dns" if category=="dns" else stage
        raise error(f"联网搜索连不上。恢复：检查网络后再说一次。\n{reason}",category=category,stage=phase) from exc
    except ssl.SSLCertVerificationError as exc:
        raise SearchFailure("搜索证书校验失败，未重试或切换备用。",category="tls_certificate",stage=stage) from exc
    except ssl.SSLEOFError as exc:
        raise RetryableSearchError("搜索TLS连接被提前关闭（UNEXPECTED_EOF_WHILE_READING）。",category="tls_eof",stage="tls_handshake" if stage=="connect_or_response_headers" else stage) from exc
    except http.client.IncompleteRead as exc:
        raise RetryableSearchError("搜索响应传输中断，未取得完整正文。",category="incomplete_read",stage="response_body") from exc
    except ConnectionResetError as exc:
        raise RetryableSearchError("联网搜索连接中断。恢复：稍后重试。",category="connection_reset",stage=stage) from exc
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError("联网搜索没有返回 JSON。不要编。") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("联网搜索返回不是对象。不要编。")
    # 服务端自身搜索上游失败时可能仍返回 HTTP 200。
    if not payload.get("results"):
        message = str(payload.get("error") or payload.get("message") or "")
        if _temporary_message(message):
            raise RetryableSearchError(f"联网搜索失败：{message} 不要编。",category="upstream_temporary",stage="upstream_response")
    return payload


def _http_error(status: int, detail: str) -> str:
    message = ""
    try:
        payload = json.loads(detail)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        message = str(payload.get("message") or payload.get("error") or payload.get("code") or "").strip()
    if not message:
        message = detail.strip()[:300]
    return f"联网搜索失败（HTTP {status}）。{message}"
