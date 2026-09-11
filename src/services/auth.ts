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
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return identityFromUser(data.user);
}

export function onAuthIdentityChange(onChange: (identity: Identity | null) => void) {
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    onChange(session?.user ? identityFromUser(session.user) : null);
  });
  return () => data.subscription.unsubscribe();
}

export async function signInWithGoogle(role: Role) {
  if (!supabase) return { mode: "local" as const };
  saveRole(role);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
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
