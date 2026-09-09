import { useState, type FormEvent } from "react";
import { API_BASE_URL } from "@/lib/api-config";

/** Email capture that mails the visitor their Mac download link
    (`POST /api/download-link`). Phones can't install the desktop app, so this
    replaces download buttons on phone layouts: the hero CTA and the
    Get LYKN section at the bottom of the home page. `fieldId` keeps the
    input ids unique when both instances render on one page. */
export default function SendDownloadLink({ fieldId }: { fieldId: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || sent) return;
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE_URL}/api/download-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(
          res.status === 429
            ? "Too many tries. Give it a minute and try again."
            : "Couldn't send right now. Try again in a moment."
        );
        return;
      }
      setSent(true);
    } catch {
      setError("Couldn't reach LYKN. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <p className="gl-getlink-done" role="status">
        Link sent - open it on your Mac
      </p>
    );
  }

  return (
    <>
      <form className="gl-getlink-form" onSubmit={onSubmit} noValidate>
        <label className="gl-getlink-sr" htmlFor={fieldId}>
          Email yourself the Mac download link
        </label>
        <input
          id={fieldId}
          className="gl-getlink-input"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="Enter your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          required
        />
        <button className="gl-getlink-btn" type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send the link"}
        </button>
      </form>
      {error ? (
        <p className="gl-getlink-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
