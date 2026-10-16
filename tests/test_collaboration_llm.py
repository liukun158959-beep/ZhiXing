import json
import unittest

import httpx

from desk_companion.collaboration_llm import CollaborationLLM

MODEL = dict(model='fixture', api_key='fixture-key', base_url='https://example.invalid/v1/')
SAMPLING = dict(reasoning_effort='low', temperature=.5, top_p=1)


class StreamingTests(unittest.TestCase):
    def llm(self, handler):
        client = httpx.Client(transport=httpx.MockTransport(handler))
        self.addCleanup(client.close)
        return CollaborationLLM(MODEL, SAMPLING, 20, client)

    def test_stream_separates_reasoning_preserves_usage_and_tool_fragments(self):
        seen = []
        chunks = [dict(choices=[dict(index=0, delta=dict(reasoning_content='private'))]),
                  dict(choices=[dict(index=0, delta=dict(content='你好', tool_calls=[dict(index=0,id='call-1',function=dict(name='web_',arguments='{"query":'))]))]),
                  dict(choices=[dict(index=0, delta=dict(tool_calls=[dict(index=0,function=dict(name='search',arguments='"AI"}'))]),finish_reason='tool_calls')]),
                  dict(choices=[], usage=dict(prompt_tokens=12,completion_tokens=9,total_tokens=21))]
        def handle(request):
            body=json.loads(request.content);seen.append(body)
            self.assertEqual(request.url.path,'/v1/chat/completions')
            self.assertEqual(request.headers['Authorization'],'Bearer fixture-key')
            return httpx.Response(200,text=': keepalive\n\n'+''.join('data: '+json.dumps(c)+'\n\n' for c in chunks)+'data: [DONE]\n\n')
        llm=self.llm(handle);text=[];reasoning=[];llm.on_reasoning=reasoning.append
        result=llm.chat([dict(role='user',content='test')],tools=[dict(type='function')],on_delta=text.append)
        self.assertEqual(text,['你好']);self.assertEqual(reasoning,['private'])
        self.assertNotIn('private',json.dumps(result))
        self.assertEqual(result['usage']['total_tokens'],21)
        self.assertEqual(result['message']['tool_calls'][0]['function'],dict(name='web_search',arguments='{"query":"AI"}'))
        self.assertEqual(seen[0]['reasoning_effort'],'low')
        self.assertTrue(seen[0]['stream_options']['include_usage'])

    def test_incomplete_stream_retains_delivered_tokens_and_never_retries(self):
        calls=[];text=[]
        def handle(request):
            calls.append(request)
            return httpx.Response(200,text='data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        with self.assertRaisesRegex(RuntimeError,'提前结束'):
            self.llm(handle).chat([],on_delta=text.append)
        self.assertEqual(text,['partial']);self.assertEqual(len(calls),1)

    def test_http_error_is_not_replayed(self):
        calls=[]
        def handle(request):
            calls.append(request);return httpx.Response(429,text='rate limit')
        with self.assertRaises(httpx.HTTPStatusError):self.llm(handle).chat([])
        self.assertEqual(len(calls),1)


if __name__ == '__main__':unittest.main()
