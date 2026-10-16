import io
import json
from email.message import Message
import socket
import ssl
import unittest
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch

from desk_companion import web_sources as sources
REAL_OPEN=sources._open


class Response(io.BytesIO):
    def __init__(self,text,mime='text/html'):
        super().__init__(text.encode())
        self.status=200;self.headers=Message();self.headers['Content-Type']=mime+'; charset=utf-8'


class SourcesTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        self.dns=patch.object(sources.socket,'getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('93.184.216.34',443))]).start()
        self.open=patch.object(sources,'_open').start()

    def test_extracts_main_and_drops_script_nav_with_explicit_truncation(self):
        text='<title>Official</title><nav>NO_NAV</nav><script>NO_SCRIPT</script><main><h1>Model</h1><p>'+('Real source paragraph. '*800)+'</p><a href="/models">Models</a></main><footer>NO_FOOTER</footer>'
        self.open.return_value=Response(text)
        page=sources.fetch_page('https://example.org/intro')
        self.assertTrue(page['truncated']);self.assertEqual(page['extraction'],'main')
        self.assertEqual(page['title'],'Official');self.assertEqual(len(page['text']),sources.MAX_TEXT)
        self.assertNotIn('NO_',page['text']);self.assertIn('https://example.org/models',page['links'])
        self.assertEqual(len(page['sha256']),64)

    def test_blocks_private_dns_credentials_ports_and_non_http_before_network(self):
        for url in ['file:///C:/secret','http://localhost/a','https://name:pass@example.org/a','https://example.org:4321/a']:
            with self.subTest(url=url),self.assertRaises(ValueError):sources.fetch_page(url)
        self.dns.return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]
        with self.assertRaises(ValueError):sources.fetch_page('https://public-looking.example/a')
        self.open.assert_not_called()

    def test_redirect_is_revalidated_and_does_not_forward_auth_or_cookies(self):
        headers=Message();headers['Location']='http://127.0.0.1/private'
        self.open.side_effect=urllib.error.HTTPError('https://example.org',302,'Found',headers,io.BytesIO())
        def dns(host,*args,**kwargs):return [(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1' if host=='127.0.0.1' else '93.184.216.34',443))]
        self.dns.side_effect=dns
        with self.assertRaises(ValueError):sources.fetch_page('https://example.org')
        self.assertEqual(self.open.call_count,1)
        request=self.open.call_args.args[0]
        self.assertFalse(any(k.lower() in {'authorization','cookie'} for k,v in request.header_items()))

    def test_retries_transient_eof_but_never_certificate_errors(self):
        self.open.side_effect=[urllib.error.URLError(ssl.SSLEOFError('EOF')),Response('<main>'+('Valid content '*20)+'</main>')]
        with patch.object(sources.time,'sleep'):
            self.assertEqual(sources.fetch_page('https://example.org')['level'],'body')
        self.assertEqual(self.open.call_count,2)
        self.open.reset_mock();self.open.side_effect=urllib.error.URLError(ssl.SSLCertVerificationError('bad cert'))
        with self.assertRaises(urllib.error.URLError):sources.fetch_page('https://example.org')
        self.assertEqual(self.open.call_count,1)

    def test_rejects_pdf_empty_challenge_and_oversized_body(self):
        compressed=Response('compressed bytes '*10);compressed.headers['Content-Encoding']='gzip'
        for response in [compressed,Response('%PDF fake','application/pdf'),Response('<title>Just a moment...</title><p>'+('x'*100)+'</p>'),Response('x'*20),Response('x'*(sources.MAX_BYTES+1),'text/plain')]:
            self.open.return_value=response
            with self.assertRaises(ValueError):sources.fetch_page('https://example.org')

    def test_citations_use_retrieved_url_levels_not_any_plausible_domain(self):
        ledger=[dict(url='https://example.org/search',level='snippet'),dict(url='https://example.org/body',requested_url='https://example.org/old',level='body',truncated=True)]
        audit=sources.check_citations('[source](https://example.org/old#section)\n[summary](https://example.org/search)\n`https://api.example.org/v1`',ledger)
        self.assertTrue(audit['ok']);self.assertEqual(audit['pages_read'],1)
        self.assertEqual([x['level'] for x in audit['matched']],['body','snippet'])
        self.assertFalse(sources.check_citations('[fake](https://example.org/not-read)',ledger)['ok'])
        self.assertFalse(sources.check_citations('No citation',ledger)['ok'])
        self.assertTrue(sources.check_citations('[正文](https://example.org/body)、[摘要](https://example.org/search)。',ledger)['ok'])
        self.assertEqual(sources.urls('[维基](https://example.org/Jev_(AI_model))。'),['https://example.org/Jev_(AI_model)'])

    def test_evidence_ids_render_exact_links_and_cannot_invent_or_rebind_sources(self):
        ledger=[dict(url='https://example.org/doc_(v1)',level='snippet',text='summary'),dict(url='https://example.org/other',level='body',text='other')]
        ledger.append(dict(url='https://example.org/doc_(v1)',level='body',text='actual body'))
        catalog=sources.source_catalog(ledger)
        self.assertEqual([s['level'] for s in catalog],['body','body'])
        self.assertEqual(catalog[0]['id'],sources.source_catalog(ledger[2:])[0]['id'])
        text,unknown=sources.render_citations(f"事实 [{catalog[0]['id']}] 和 [{catalog[1]['id']}]，未知 [S3]，`[S99]`",ledger)
        self.assertEqual(unknown,['S3']);self.assertIn('`[S99]`',text)
        self.assertIn('[1](<https://example.org/doc_(v1)>)',text)
        self.assertTrue(sources.check_citations(text,ledger)['ok'])
        self.assertFalse(sources.source_catalog([dict(url='https://user:secret@example.org/doc'),dict(url='https://example.org/x>bad')]))

    def test_transport_pins_public_ip_and_original_tls_name_through_proxy(self):
        # Exercise the real transport factory rather than the extraction stub.
        tunnels=[]
        with patch.object(sources.socket,'create_connection') as tcp,patch.object(sources.ssl,'create_default_context') as tls,\
             patch.object(sources.urllib.request,'proxy_bypass',return_value=False),\
             patch.object(sources.urllib.request,'getproxies',return_value={'https':'http://127.0.0.1:7890'}),\
             patch.object(sources.http.client.HTTPConnection,'request',lambda conn,*args,**kwargs:conn.connect()),\
             patch.object(sources.http.client.HTTPConnection,'_tunnel',lambda conn:tunnels.append((conn._tunnel_host,conn._tunnel_port))),\
             patch.object(sources.http.client.HTTPConnection,'getresponse',return_value=SimpleNamespace(status=200,close=lambda:None)):
            with REAL_OPEN(sources.urllib.request.Request('https://example.org/doc'),5):pass
            self.assertEqual(tcp.call_args.args[0],('127.0.0.1',7890))
            self.assertEqual(tunnels,[('93.184.216.34',443)])
            self.assertEqual(tls.return_value.wrap_socket.call_args.kwargs['server_hostname'],'example.org')


if __name__=='__main__':unittest.main()
