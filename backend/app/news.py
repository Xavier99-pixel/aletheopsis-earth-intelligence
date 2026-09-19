"""Bounded news discovery. Article mentions are not geospatial observations."""

import asyncio
import ipaddress
import json
import re
import time
from collections import OrderedDict
from datetime import datetime, timezone
from html import unescape
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/api/news", tags=["news"])
GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
MAX_RESPONSE_BYTES = 1_000_000
MAX_ARTICLES = 12
CACHE_SECONDS = 300
_cache: OrderedDict[tuple[str, str], tuple[float, dict]] = OrderedDict()
_provider_slots = asyncio.Semaphore(4)

Category = Literal["environment", "flood", "urban"]
CATEGORY_QUERIES = {
    "environment": "(environment OR pollution OR conservation OR wetland)",
    "flood": "(flood OR flooding OR rainfall OR barrage)",
    "urban": '("urban planning" OR infrastructure OR construction OR zoning)',
}

# Exact domains and their subdomains only. A label identifies the publisher;
# it is not a claim that a news article is an official warning or legal order.
OFFICIAL_DOMAINS = {
    "pib.gov.in": "Press Information Bureau",
    "imd.gov.in": "India Meteorological Department",
    "cwc.gov.in": "Central Water Commission",
    "nrsc.gov.in": "National Remote Sensing Centre",
    "ndma.gov.in": "National Disaster Management Authority",
}
OFFICIAL_RESOURCES = [
    {"name": "PIB · government releases", "url": "https://pib.gov.in/", "kind": "reference_portal"},
    {"name": "IMD · weather warnings", "url": "https://mausam.imd.gov.in/", "kind": "reference_portal"},
    {"name": "CWC · water information", "url": "https://cwc.gov.in/", "kind": "reference_portal"},
    {"name": "NRSC · satellite applications", "url": "https://www.nrsc.gov.in/", "kind": "reference_portal"},
    {"name": "NDMA · disaster guidance", "url": "https://ndma.gov.in/", "kind": "reference_portal"},
]


def safe_article_url(value: object) -> str | None:
    """Allow public web links only; never request article URLs server-side."""
    if not isinstance(value, str) or len(value) > 2048:
        return None
    if re.search(r"[\s\\\x00-\x1f\x7f]", value):
        return None
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower().rstrip(".")
        if parts.scheme not in {"http", "https"} or parts.username or parts.password:
            return None
        if parts.port not in {None, 80, 443}:
            return None
        if not host or "." not in host or host.endswith((".local", ".localhost", ".internal", ".test", ".invalid")):
            return None
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            return None
        ascii_host = host.encode("idna").decode("ascii")
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", ascii_host):
            return None
        if any(not label or len(label) > 63 or label.startswith("-") or label.endswith("-") for label in ascii_host.split(".")):
            return None
        # Reject browser-specific numeric host forms (including 127.1).
        if ascii_host.rsplit(".", 1)[-1].isdigit():
            return None
        netloc = ascii_host + (f":{parts.port}" if parts.port else "")
        return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
    except (ValueError, UnicodeError):
        return None


def canonical_article_key(url: str) -> str:
    parts = urlsplit(url)
    query = sorted((key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
                   if not key.lower().startswith("utm_") and key.lower() not in {"fbclid", "gclid"})
    return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), urlencode(query), ""))


def parse_seen_at(value: object) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{8}T\d{6}Z", value):
        return None
    try:
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def publisher_for(url: str) -> tuple[str, str]:
    host = (urlsplit(url).hostname or "").lower()
    for domain, publisher in OFFICIAL_DOMAINS.items():
        if host == domain or host.endswith(f".{domain}"):
            return publisher, "official_publisher"
    return host, "broader_discovery"


def article_from_record(record: object, location: str) -> dict | None:
    if not isinstance(record, dict):
        return None
    url = safe_article_url(record.get("url"))
    title = record.get("title")
    if not url or not isinstance(title, str) or not title.strip():
        return None
    title = re.sub(r"\s+", " ", unescape(title)).strip()[:500]
    source, authority = publisher_for(url)
    return {
        "title": title,
        "url": url,
        "source": source,
        "authority": authority,
        # DOC's seendate is a discovery timestamp, not independently verified
        # publication time. Do not silently rebrand it as published_at.
        "published_at": None,
        "seen_at": parse_seen_at(record.get("seendate")),
        "timestamp_basis": "provider_first_seen",
        "scope": location,
        "match_method": "provider_text_search",
        "coordinates": None,
        "geolocation_status": "not_verified",
    }


def clean_query(query: str) -> str:
    # Plain text only: quotes, URL syntax, and GDELT operators are not forwarded.
    cleaned = " ".join("".join(char if char.isalnum() or char.isspace() else " " for char in query).split())
    if len(cleaned) < 2 or not any(char.isalpha() for char in cleaned):
        raise HTTPException(status_code=422, detail="Enter a place name with at least two characters.")
    return cleaned[:120]


def response_base(location: str, category: str) -> dict:
    return {
        "provider": "GDELT DOC 2.0",
        "provider_url": "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
        "query": location,
        "category": category,
        "window_days": 30,
        "retrieved_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "cached": False,
        "articles": [],
        "resources": OFFICIAL_RESOURCES,
        "note": "News matches place names in text, not the selected map boundary. Coordinates and publication dates are not independently verified. News is context, not a flood forecast or land-authorisation record.",
    }


async def fetch_news(location: str, category: Category, client: httpx.AsyncClient) -> dict:
    result = response_base(location, category)
    params = {
        "query": f'"{location}" {CATEGORY_QUERIES[category]}',
        "mode": "artlist", "format": "json", "maxrecords": 30,
        "timespan": "30d", "sort": "datedesc",
    }
    try:
        async with client.stream("GET", GDELT_URL, params=params) as response:
            response.raise_for_status()
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > MAX_RESPONSE_BYTES:
                    raise ValueError("Oversized provider response")
        payload = json.loads(content)
        if not isinstance(payload, dict) or not isinstance(payload.get("articles"), list):
            raise ValueError("Unrecognised provider response")
    except (httpx.HTTPError, ValueError, TypeError):
        return {**result, "status": "unavailable", "message": "News provider unavailable or returned an unusable response. Try again later; official reference portals remain available."}

    articles = []
    seen: set[str] = set()
    rejected = 0
    for record in payload["articles"][:100]:
        article = article_from_record(record, location)
        if not article:
            rejected += 1
            continue
        key = canonical_article_key(article["url"])
        if key in seen:
            continue
        seen.add(key)
        articles.append(article)
        if len(articles) == MAX_ARTICLES:
            break
    result["articles"] = articles
    result["omitted_invalid_records"] = rejected
    if articles:
        return {**result, "status": "ok", "message": f"{len(articles)} source-linked articles found. Open the publisher to verify the report."}
    if payload["articles"]:
        return {**result, "status": "unavailable", "message": "The provider returned records, but none contained usable article links and titles."}
    return {**result, "status": "no_results", "message": "No articles matched this place and topic in the last 30 days. This is not evidence that no events occurred."}


@router.get("/geospatial")
async def geospatial_news(query: str = Query(min_length=2, max_length=120), category: Category = "environment"):
    location = clean_query(query)
    key = (location.casefold(), category)
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        _cache.move_to_end(key)
        return {**cached[1], "cached": True}
    async with _provider_slots:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            result = await fetch_news(location, category, client)
    if result["status"] != "unavailable":
        _cache[key] = (time.monotonic(), result)
        _cache.move_to_end(key)
        while len(_cache) > 128:
            _cache.popitem(last=False)
    return result
