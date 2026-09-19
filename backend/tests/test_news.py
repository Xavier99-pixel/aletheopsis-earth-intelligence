import unittest

import httpx
from fastapi import HTTPException

from app.news import (
    GDELT_URL, MAX_RESPONSE_BYTES, article_from_record, clean_query,
    fetch_news, parse_seen_at, publisher_for, safe_article_url,
)


class NewsValidationTests(unittest.TestCase):
    def test_only_safe_web_links_are_returned(self):
        rejected = ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd",
                    "https://user:pass@example.org/article", "https://127.0.0.1/x",
                    "http://127.1/x", "http://localhost/x", "https://host.local/x",
                    "https://example.org:8000/x", "https://example.org\\@localhost/x",
                    "https://example.org/\narticle", "//example.org/x", "https://bad..org/x"]
        for value in rejected:
            with self.subTest(value=value):
                self.assertIsNone(safe_article_url(value))
        self.assertEqual(safe_article_url("https://www.nrsc.gov.in/news#section"), "https://www.nrsc.gov.in/news")

    def test_official_allowlist_checks_domain_boundaries(self):
        self.assertEqual(publisher_for("https://mausam.imd.gov.in/a")[1], "official_publisher")
        self.assertEqual(publisher_for("https://imd.gov.in.evil.org/a")[1], "broader_discovery")
        self.assertEqual(publisher_for("https://fakeimd.gov.in/a")[1], "broader_discovery")

    def test_timestamp_is_validated_and_never_mislabeled_as_publication(self):
        self.assertEqual(parse_seen_at("20260918T010203Z"), "2026-09-18T01:02:03Z")
        for value in ["20260230T010203Z", "20260918", "not-a-date", None, 42]:
            self.assertIsNone(parse_seen_at(value))
        article = article_from_record({"url": "https://example.org/story", "title": "River &amp; city", "seendate": "bad"}, "Vijayawada")
        self.assertEqual(article["title"], "River & city")
        self.assertIsNone(article["published_at"])
        self.assertIsNone(article["seen_at"])
        self.assertIsNone(article["coordinates"])

    def test_query_cannot_add_provider_operators(self):
        self.assertEqual(clean_query('Vijayawada" OR domain:evil.org'), "Vijayawada OR domain evil org")
        with self.assertRaises(HTTPException):
            clean_query("500 200")


class NewsProviderTests(unittest.IsolatedAsyncioTestCase):
    async def run_provider(self, handler):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await fetch_news("Vijayawada", "flood", client)

    async def test_fixed_endpoint_parameters_deduplication_and_untrusted_data(self):
        def handler(request):
            self.assertEqual(str(request.url).split("?")[0], GDELT_URL)
            self.assertEqual(request.url.params["timespan"], "30d")
            self.assertIn('"Vijayawada"', request.url.params["query"])
            return httpx.Response(200, json={"articles": [
                {"url": "https://example.org/story?utm_source=one", "title": "River flood", "seendate": "20260918T010203Z", "domain": "pib.gov.in"},
                {"url": "https://example.org/story?utm_source=two", "title": "Duplicate"},
                {"url": "javascript:alert(1)", "title": "Unsafe"},
                {"url": "https://pib.gov.in/release", "title": "Government release"},
            ]})
        result = await self.run_provider(handler)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["articles"]), 2)
        self.assertEqual(result["articles"][0]["source"], "example.org")
        self.assertEqual(result["articles"][0]["authority"], "broader_discovery")
        self.assertEqual(result["omitted_invalid_records"], 1)

    async def test_provider_outage_distinct_from_empty_results(self):
        failed = await self.run_provider(lambda _: httpx.Response(503))
        empty = await self.run_provider(lambda _: httpx.Response(200, json={"articles": []}))
        malformed = await self.run_provider(lambda _: httpx.Response(200, text="Please wait before retrying"))
        invalid = await self.run_provider(lambda _: httpx.Response(200, json={"articles": [{"url": "file:///x", "title": "Bad"}]}))
        self.assertEqual(failed["status"], "unavailable")
        self.assertEqual(empty["status"], "no_results")
        self.assertEqual(malformed["status"], "unavailable")
        self.assertEqual(invalid["status"], "unavailable")
        self.assertEqual(len(failed["resources"]), 5)

    async def test_oversized_response_is_rejected(self):
        result = await self.run_provider(lambda _: httpx.Response(200, content=b" " * (MAX_RESPONSE_BYTES + 1)))
        self.assertEqual(result["status"], "unavailable")

    async def test_timeout_is_reported_without_details_from_provider(self):
        def handler(request):
            raise httpx.ReadTimeout("upstream timeout", request=request)
        result = await self.run_provider(handler)
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn("upstream timeout", result["message"])


if __name__ == "__main__":
    unittest.main()
