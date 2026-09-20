import { useState, type FormEvent } from "react";
import { ArrowRight, Chrome, LoaderCircle, Mail, ShieldCheck } from "lucide-react";
import { authConfigured, sendMagicLink, signInWithGoogle, signInWithPassword } from "../services/auth";
import type { Identity, Role } from "../lib/types";
import { ROLES } from "../lib/types";
import { BrandMark } from "./BrandMark";
import { CesiumGlobe } from "./CesiumGlobe";

type AccessGateProps = {
  onAuthenticated: (identity: Identity) => void;
};

export function AccessGate({ onAuthenticated }: AccessGateProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [role, setRole] = useState<Role>("Researcher");
  const [busy, setBusy] = useState<"google" | "email" | "password" | null>(null);
  const [message, setMessage] = useState("");

  async function enterWithGoogle() {
    setBusy("google");
    setMessage("");
    try {
      const response = await signInWithGoogle(role);
      if (response.mode === "local") {
        onAuthenticated({ email: "local@aletheopsis", role, mode: "local" });
      }
    } catch {
      setMessage("Google sign-in could not start. Check the Supabase OAuth configuration.");
    } finally {
      setBusy(null);
    }
  }

  async function enterWithEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      setMessage("Enter a valid work or research email address.");
      return;
    }
    setBusy("email");
    setMessage("");
    try {
      const response = await sendMagicLink(normalizedEmail, role);
      if (response.mode === "local") {
        onAuthenticated({ email: normalizedEmail, role, mode: "local" });
      } else {
        setMessage("Magic link sent. Check your inbox, then return here.");
      }
    } catch {
      setMessage("Email sign-in could not start. Check the Supabase Auth configuration.");
    } finally {
      setBusy(null);
    }
  }

  async function enterAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("password"); setMessage("");
    try { onAuthenticated(await signInWithPassword(adminEmail.trim(), password)); setPassword(""); }
    catch { setMessage("Admin sign-in failed. Check your email and password. Government permissions must be provisioned by your administrator."); }
    finally { setBusy(null); }
  }

  return (
    <main className="access-gate">
      <CesiumGlobe variant="landing" />
      <div className="access-gate__veil" aria-hidden="true" />
      <section className="access-card" aria-label="Sign in to Aletheopsis">
        <div className="access-card__topline" aria-label="Secure workspace">
          <span className="status-dot" aria-hidden="true" />
          <span>Secure workspace</span>
          <span className="access-card__mode">{authConfigured ? "Identity ready" : "Demo mode"}</span>
        </div>
        <BrandMark />
        <h1>Enter the workspace</h1>
        <p className="access-card__intro">Choose an access profile. Every investigation keeps its source and decision trail attached.</p>

        <label className="field-label" htmlFor="role">Operating role</label>
        <select id="role" className="role-select" value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {ROLES.map((item) => <option key={item}>{item}</option>)}
        </select>

        <button type="button" className="google-button" onClick={enterWithGoogle} disabled={busy !== null}>
          {busy === "google" ? <LoaderCircle className="spin" size={18} /> : authConfigured ? <Chrome size={18} /> : <ShieldCheck size={18} />}
          {authConfigured ? "Continue with Google" : "Open demonstration workspace"}
          <ArrowRight size={17} />
        </button>

        {authConfigured && <>
          <div className="divider"><span>or use email</span></div>

          <form onSubmit={enterWithEmail} className="email-form">
            <label className="field-label" htmlFor="email">Work or research email</label>
            <div className="email-input">
              <Mail size={17} />
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@organisation.org"
                autoComplete="email"
              />
            </div>
            <button type="submit" className="primary-button" disabled={busy !== null}>
              {busy === "email" ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}
              Send secure link
            </button>
          </form>
        </>}

        {authConfigured && <details className="admin-login"><summary>Admin sign in</summary>
          <p>Use your provisioned government account. Department access is checked by the server.</p>
          <form onSubmit={enterAdmin}>
            <label>Admin email<input type="email" autoComplete="username" required value={adminEmail} onChange={event=>setAdminEmail(event.target.value)}/></label>
            <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event=>setPassword(event.target.value)}/></label>
            <button type="submit" className="primary-button" disabled={busy!==null}>{busy==="password" ? "Signing in…" : "Sign in as administrator"}</button>
          </form>
        </details>}
        {message && <p className="access-message" role="status">{message}</p>}
        {!authConfigured && (
          <p className="access-disclosure">
            Authentication is not configured in this deployment. You can still explore the public demonstration workspace.
          </p>
        )}
      </section>
    </main>
  );
}
