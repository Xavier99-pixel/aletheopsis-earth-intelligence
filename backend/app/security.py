"""Shared guards for server-side, cost-bearing intelligence capabilities."""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from collections import defaultdict, deque
from typing import Deque

import httpx
from fastapi import Header, HTTPException


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _bounded_int(value: str | None, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value or default)
    except ValueError:
        return default
    return max(minimum, min(maximum, parsed))


class SlidingWindowLimiter:
    """Small per-instance safety valve. Use a shared store for multi-instance scale."""

    def __init__(self, maximum_requests: int, window_seconds: int = 60):
        self.maximum_requests = maximum_requests
        self.window_seconds = window_seconds
        self._events: dict[str, Deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def consume(self, key: str) -> None:
        now = time.monotonic()
        async with self._lock:
            events = self._events[key]
            cutoff = now - self.window_seconds
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= self.maximum_requests:
                raise HTTPException(status_code=429, detail="Too many intelligence requests. Try again shortly.")
            events.append(now)


intelligence_limiter = SlidingWindowLimiter(
    _bounded_int(os.getenv("INTELLIGENCE_MAX_REQUESTS_PER_MINUTE"), 12, 1, 120),
)


async def verified_intelligence_subject(authorization: str | None = Header(default=None)) -> str:
    """Verify the signed-in Supabase user before spending a hosted-model token."""

    if _truthy(os.getenv("INTELLIGENCE_ALLOW_UNAUTHENTICATED")):
        # Development-only escape hatch. It must never be enabled in Render.
        return "development-unauthenticated"

    if not authorization:
        raise HTTPException(status_code=401, detail="Authentication is required for hosted intelligence.")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or len(token.strip()) < 20:
        raise HTTPException(status_code=401, detail="Authentication is required for hosted intelligence.")

    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    if not supabase_url or not supabase_anon_key:
        raise HTTPException(status_code=503, detail="Hosted intelligence authentication is not configured.")

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{supabase_url}/auth/v1/user",
                headers={"Authorization": f"Bearer {token.strip()}", "apikey": supabase_anon_key},
            )
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Authentication service is temporarily unavailable.") from error

    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Authentication is required for hosted intelligence.")
    try:
        payload = response.json()
    except ValueError as error:
        raise HTTPException(status_code=401, detail="Authentication is required for hosted intelligence.") from error
    user_id = payload.get("id") if isinstance(payload, dict) else None
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(status_code=401, detail="Authentication is required for hosted intelligence.")

    # The model provider receives an opaque, non-reversible safety identifier.
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()
