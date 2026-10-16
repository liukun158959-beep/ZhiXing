import json
import unittest

from desk_companion.collaboration_stream import ReportText, RouteText


class PublicStreamTests(unittest.TestCase):
    def test_route_plain_answer_arrives_before_completion_but_control_json_never_does(self):
        events=[];stream=RouteText(lambda k,d:events.append((k,d)))
        stream.push('你好');self.assertEqual(events,[('token','你好')])
        stream.push('，继续讨论。');self.assertEqual(events[-1],('token','，继续讨论。'))
        for source in (' {"mode":"task","instructions":"private control"}', '```json\n{"mode":"task"}\n```', '```\n{"mode":"task"}\n```'):
            events=[];stream=RouteText(lambda k,d:events.append((k,d)))
            for char in source:stream.push(char)
            self.assertEqual(events,[])
        events=[];stream=RouteText(lambda k,d:events.append((k,d)))
        for char in '```python\nprint(1)\n```':stream.push(char)
        self.assertEqual(''.join(d for k,d in events),'```python\nprint(1)\n```')

    def test_report_decodes_split_escapes_unicode_and_streams_only_public_field(self):
        for ensure_ascii in (False,True):
            events=[];stream=ReportText(lambda k,d:events.append((k,d)))
            report='# 报告\n\n"引文" \\ 路径 😀\n来源 [A](https://example.org)'
            raw=json.dumps(dict(complete=True,limitations=['private control'],report=report,missing=[]),ensure_ascii=ensure_ascii)
            first=None
            for i in range(1,len(raw)+1):
                stream.push(0,'submit_deliverable',raw[:i])
                if events and first is None:first=i
            self.assertEqual(''.join(d for k,d in events),report)
            self.assertLess(first,raw.index('missing'))
            self.assertNotIn('private control',str(events))

    def test_other_tools_nested_report_and_other_call_indices_do_not_leak(self):
        events=[];stream=ReportText(lambda k,d:events.append((k,d)))
        stream.push(1,'submit_deliverable','{"report":"other parallel call"}')
        stream.push(0,'workspace_write','{"report":"private file content"}')
        raw='{"metadata":{"report":"nested"},"report":"public"}'
        for i in range(len(raw)+1):stream.push(0,'submit_deliverable',raw[:i])
        self.assertEqual(events,[('token','p'),('token','u'),('token','b'),('token','l'),('token','i'),('token','c')])
