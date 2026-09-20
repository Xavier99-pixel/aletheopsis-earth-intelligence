"""Explicit, server-only Supabase government administrator provisioning.

No password or service key is logged, returned to clients, or stored locally.
Existing accounts require their explicit UUID and are never password-reset.
"""
import logging
import os
import re
from uuid import UUID
from urllib.parse import urlparse
import httpx

logger = logging.getLogger(__name__)

async def provision_admin():
    if os.getenv("BOOTSTRAP_ADMIN_ENABLED", "").lower() != "true":
        return "disabled"
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
    department = os.getenv("BOOTSTRAP_ADMIN_DEPARTMENT_ID", "").strip()
    user_id = os.getenv("BOOTSTRAP_ADMIN_USER_ID", "").strip()
    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
    if urlparse(url).scheme != "https" or not urlparse(url).hostname or not key or "@" not in email or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", department):
        raise ValueError("Admin bootstrap requires valid Supabase URL, service key, email and department ID.")
    if user_id:
        user_id = str(UUID(user_id))
    elif len(password) < 16 or os.getenv("BOOTSTRAP_ADMIN_EMAIL_VERIFIED", "").lower() != "true":
        raise ValueError("New administrators require a password of at least 16 characters and verified email ownership.")
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    metadata = {"department_id": department, "government_role": "government_admin"}
    async with httpx.AsyncClient(timeout=15, headers=headers) as client:
        if user_id:
            response = await client.get(f"{url}/auth/v1/admin/users/{user_id}")
            if response.status_code != 200:
                raise RuntimeError("Could not verify the specified admin account.")
            current = response.json()
            if current.get("email", "").lower() != email:
                raise ValueError("The specified admin user ID does not match the configured email.")
            existing = current.get("app_metadata") or {}
            if all(existing.get(k) == v for k,v in metadata.items()):
                return "already_provisioned"
            response = await client.put(f"{url}/auth/v1/admin/users/{user_id}", json={"app_metadata": {**existing, **metadata}})
        else:
            response = await client.post(f"{url}/auth/v1/admin/users", json={"email":email,"password":password,"email_confirm":True,"app_metadata":metadata})
        if response.status_code not in {200, 201}:
            # Do not log upstream response bodies; they can contain account details.
            raise RuntimeError("Admin provisioning failed. For an existing account, set its verified BOOTSTRAP_ADMIN_USER_ID.")
    return "provisioned"

async def bootstrap_on_startup():
    try:
        status = await provision_admin()
        if status != "disabled":
            logger.warning("Admin bootstrap: %s. Disable BOOTSTRAP_ADMIN_ENABLED after setup.", status)
    except (ValueError, RuntimeError, httpx.HTTPError):
        logger.error("Admin bootstrap failed. Check server-only bootstrap configuration and the setup guide. No credentials were logged.")
