# Render administrator setup

This release adds **Admin sign in** to the configured Supabase login screen. An admin ID is a Supabase Auth user UUID; it is not an arbitrary username or an environment variable that bypasses authentication. The email/password signs in through Supabase. The API verifies the user and the server-managed department role on every government request.

## Create a new administrator

In Render, open **aletheopsis-earth-intelligence-api → Environment**. Set these **backend-only** values:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_EXISTING_PUBLIC_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
BOOTSTRAP_ADMIN_ENABLED=true
BOOTSTRAP_ADMIN_EMAIL=YOUR_OWN_VERIFIED_EMAIL
BOOTSTRAP_ADMIN_PASSWORD=YOUR_UNIQUE_PASSWORD_AT_LEAST_16_CHARACTERS
BOOTSTRAP_ADMIN_DEPARTMENT_ID=land-revenue-vijayawada
BOOTSTRAP_ADMIN_EMAIL_VERIFIED=true
```

Replace the placeholders. `BOOTSTRAP_ADMIN_EMAIL_VERIFIED=true` is your explicit assertion that you control and have verified that email address. Create your password in a password manager; do not commit it or place it in chat. Never prefix the service-role key or password with `VITE_`. The static site needs only its existing `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and API `VITE_BACKEND_BASE_URL`.

Save and deploy the API. On successful startup, its Render log reports `Admin bootstrap: provisioned`. Supabase **Authentication → Users** lists the newly created account and its UUID. The service gives it server-managed `app_metadata`:

```json
{"department_id":"land-revenue-vijayawada","government_role":"government_admin"}
```

Then set `BOOTSTRAP_ADMIN_ENABLED=false` and remove `BOOTSTRAP_ADMIN_PASSWORD` and `SUPABASE_SERVICE_ROLE_KEY` from Render; redeploy. The account and its role persist in Supabase. Sign in on the site via **Admin sign in**, then open **Government**. The read-only session display now includes the user ID. Supabase Auth email/password sign-in must be enabled.

Bootstrap failures are logged without credentials and do not take down public catalogue/research services. A failed bootstrap does not grant access. Look for the success log before disabling setup.

## Provision an existing account

Set `BOOTSTRAP_ADMIN_USER_ID` to the exact UUID from Supabase Authentication, alongside that account's `BOOTSTRAP_ADMIN_EMAIL`, the department ID, service-role key, Supabase URL and `BOOTSTRAP_ADMIN_ENABLED=true`. No password or email-verification flag is needed for this path. The server checks that the UUID's email matches, preserves unrelated metadata and never resets the password. An existing account with matching permissions is left unchanged. Disable bootstrap and remove the service key after success.

Creating by email intentionally fails if that account already exists; it never silently promotes an existing user. Use the explicit UUID path instead.

## Government database

Account creation is separate from land records. Configure the API's `DATABASE_URL` with PostGIS and apply `backend/app/db/migrations/002_land_monitor.sql` as described in `GOVERNMENT.md`. The account's department ID must match the department that owns imported records. Until that database is ready, government storage operations report unavailable. Public/demo access and selecting “Government official” in the role dropdown never grant these permissions.

## Verification boundaries

Automated tests cover bootstrap configuration, new-user role payloads, existing-user email matching and password preservation. A real account cannot be created until you set your own backend environment variables. No password or service-role key ships in this repository.

References: [Supabase admin creation](https://supabase.com/docs/reference/python/auth-admin-createuser), [Supabase admin updates](https://supabase.com/docs/reference/python/auth-admin-updateuserbyid).
