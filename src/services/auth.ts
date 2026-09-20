import { createClient, type User } from "@supabase/supabase-js";
import { ROLES, type Identity, type Role } from "../lib/types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

function hasUsableAuthConfig(url: string | undefined, key: string | undefined) {
  if (!url || !key) return false;
  const candidate = `${url} ${key}`.toLowerCase();
  if (/your[-_ ]|placeholder|example|replace[-_ ]me|<|>/.test(candidate)) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && key.trim().length > 32;
  } catch {
    return false;
  }
}

// Avoid presenting a broken Google/email sign-in when deployment variables are
// still template values. A local demo workspace remains usable in that case.
export const authConfigured = hasUsableAuthConfig(supabaseUrl, supabaseAnonKey);

const supabase = authConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

const roleStorageKey = "aletheopsis.selected-role";
const oauthIntentStorageKey = "aletheopsis.oauth-intent";
const authenticatedWindowStorageKey = "aletheopsis.authenticated-window";
const oauthIntentLifetimeMs = 10 * 60 * 1000;

function hasAuthCallbackInUrl() {
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return ["code", "access_token", "refresh_token", "error", "error_code"].some(
    (key) => query.has(key) || fragment.has(key),
  );
}

// Capture this before Supabase consumes a code or access-token fragment.
const arrivedFromAuthCallback = hasAuthCallbackInUrl();

function recordOAuthIntent() {
  window.sessionStorage.setItem(oauthIntentStorageKey, String(Date.now()));
}

function hasRecentOAuthIntent() {
  const timestamp = Number(window.sessionStorage.getItem(oauthIntentStorageKey));
  return Number.isFinite(timestamp) && Date.now() - timestamp >= 0 && Date.now() - timestamp < oauthIntentLifetimeMs;
}

function shouldRestoreAuthAfterLogin() {
  return arrivedFromAuthCallback || hasRecentOAuthIntent() || window.sessionStorage.getItem(authenticatedWindowStorageKey) === "true";
}

function clearOAuthIntent() {
  window.sessionStorage.removeItem(oauthIntentStorageKey);
}

export function finishAuthentication() {
  clearOAuthIntent();
  window.sessionStorage.setItem(authenticatedWindowStorageKey, "true");
}

function savedRole(): Role {
  const saved = window.localStorage.getItem(roleStorageKey);
  return ROLES.includes(saved as Role) ? (saved as Role) : "Researcher";
}

function identityFromUser(user: User): Identity {
  return {
    email: user.email ?? "verified-user@aletheopsis",
    role: savedRole(),
    mode: "authenticated",
  };
}

function saveRole(role: Role) {
  window.localStorage.setItem(roleStorageKey, role);
}

export async function getAuthenticatedIdentity(): Promise<Identity | null> {
  // A browser can retain a historical Supabase session. Do not let that session
  // bypass the sign-in screen: only restore identity after this browser returns
  // from an explicit Google/email authentication flow.
  if (!supabase || !shouldRestoreAuthAfterLogin()) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return identityFromUser(data.user);
}

/**
 * Returns a short-lived Supabase access token only after this tab completed an
 * explicit sign-in flow. It is used for server-side protected capabilities;
 * provider API keys never enter the browser.
 */
export async function getAuthenticatedAccessToken(): Promise<string | null> {
  if (!supabase || !shouldRestoreAuthAfterLogin()) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) return null;
  return data.session.access_token;
}

export function onAuthIdentityChange(onChange: (identity: Identity | null) => void) {
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user && shouldRestoreAuthAfterLogin()) {
      onChange(identityFromUser(session.user));
    } else if (event === "SIGNED_OUT") {
      onChange(null);
    }
  });
  return () => data.subscription.unsubscribe();
}

export async function signInWithGoogle(role: Role) {
  if (!supabase) return { mode: "local" as const };
  saveRole(role);
  recordOAuthIntent();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) {
    clearOAuthIntent();
    throw error;
  }
  return { mode: "authenticated" as const };
}

export async function sendMagicLink(email: string, role: Role) {
  if (!supabase) return { mode: "local" as const };
  saveRole(role);
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
  return { mode: "authenticated" as const };
}

export async function signInWithPassword(email: string, password: string): Promise<Identity> {
  if (!supabase) throw new Error("Authentication is not configured.");
  const { data, error } = await supabase.auth.signInWithPassword({email, password});
  if (error || !data.user) throw new Error("Sign-in failed. Check your email and password.");
  saveRole("Government official");
  finishAuthentication();
  return identityFromUser(data.user);
}

export async function signOut() {
  if (supabase) { const {error} = await supabase.auth.signOut(); if (error) throw error; }
  window.sessionStorage.removeItem(authenticatedWindowStorageKey);
  clearOAuthIntent();
}
