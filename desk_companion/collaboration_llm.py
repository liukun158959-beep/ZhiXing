"""Small streaming transport for collaboration workers, without importing Atlas.

The worker already owns tool dispatch, permissions, deadlines and cancellation.
Keep HTTP proxy environment and TLS verification intact; never retry a partial run.
"""
import json
import time

import httpx


class CollaborationLLM:
    def __init__(self, model, sampling, timeout, client=None, purpose='task'):
        self.model = model
        self.sampling = {**sampling, **({'reasoning_effort': 'low'} if purpose == 'route' else {})}
        self.preserve_reasoning = model['model'].lower().startswith(('glm-4.7', 'glm-5'))
        self.timeout = timeout
        self.client = client
        self.owned = client is None
        self.on_reasoning = None
        self.on_progress = None
        self.on_tool_delta = None

    def __enter__(self): return self

    def __exit__(self, *args): self.close()

    def close(self):
        if self.owned and self.client is not None:
            self.client.close(); self.client = None

    def chat(self, messages, tools=None, on_delta=None):
        payload = dict(model=self.model['model'], messages=messages, stream=True,
                       stream_options=dict(include_usage=True),
                       temperature=self.sampling['temperature'], top_p=self.sampling['top_p'],
                       thinking=dict(type='enabled'), reasoning_effort=self.sampling['reasoning_effort'])
        if tools:
            payload['tools'] = tools
        if self.preserve_reasoning:
            payload['thinking']['clear_thinking'] = False
            payload['tool_stream'] = True
        started = time.monotonic()
        if self.client is None:
            from .model_network import http_client
            self.client = http_client(self.timeout)
        client = self.client
        pieces, reasoning_pieces, calls, usage = [], [], {}, None
        finished = False
        try:
            with client.stream('POST', self.model['base_url'].rstrip('/')+'/chat/completions',
                               headers={'Authorization': 'Bearer '+self.model['api_key'], 'Accept': 'text/event-stream'},
                               json=payload) as response:
                response.raise_for_status()
                for event in _events(response.iter_lines()):
                    if event == '[DONE]':
                        finished = True
                        break
                    chunk = json.loads(event)
                    if chunk.get('error'):
                        raise RuntimeError('模型流返回错误')
                    if chunk.get('usage'):
                        usage = chunk['usage']
                    for choice in chunk.get('choices', []):
                        if choice.get('index', 0) != 0:
                            continue
                        delta = choice.get('delta') or {}
                        reasoning = delta.get('reasoning_content')
                        if reasoning and self.preserve_reasoning:
                            reasoning_pieces.append(reasoning)
                        if reasoning and self.on_reasoning:
                            self.on_reasoning(reasoning)
                        piece = delta.get('content')
                        if piece:
                            pieces.append(piece)
                            if on_delta:
                                on_delta(piece)
                        for call in delta.get('tool_calls') or []:
                            if self.on_progress:
                                self.on_progress()
                            slot = calls.setdefault(call['index'], dict(id='', type='function', function=dict(name='', arguments='')))
                            if call.get('id'):
                                slot['id'] = call['id']
                            for field in ('name', 'arguments'):
                                slot['function'][field] += (call.get('function') or {}).get(field) or ''
                            if self.on_tool_delta:
                                self.on_tool_delta(call['index'], slot['function']['name'], slot['function']['arguments'])
                        if choice.get('finish_reason'):
                            finished = True
            if not finished:
                raise RuntimeError('模型连接提前结束，未收到完成标记；部分结果已保留')
        except Exception:
            self.close()
            raise
        message = dict(role='assistant', content=''.join(pieces) or None)
        if calls:
            message['tool_calls'] = [calls[i] for i in sorted(calls)]
        if reasoning_pieces:
            message['reasoning_content'] = ''.join(reasoning_pieces)
        return dict(message=message, usage=usage, duration_ms=int((time.monotonic()-started)*1000))


def _events(lines):
    """SSE comments/keepalives and multi-line data, including a final unblanked event."""
    data = []
    for line in lines:
        if not line:
            if data:
                yield '\n'.join(data)
                data = []
        elif line.startswith('data:'):
            data.append(line[5:].lstrip(' '))
    if data:
        yield '\n'.join(data)
