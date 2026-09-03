import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import LandingHeader from "@/components/landing/LandingHeader";
import { LyknWordmark } from "@/components/landing/LyknWordmark";
import { SiteFooter } from "@/pages/GlassLanding";
import "./GlassLanding.css";
import "@/components/landing/landingIcy.css";
import "./Security.css";

const POINTS = [
  {
    title: "Signed in, scoped to you",
    body: "API requests carry your session. The server checks it, then loads rows tied to your account. Other people cannot open your LYKN by guessing an id.",
  },
  {
    title: "Encrypted where it matters",
    body: "Traffic to LYKN uses HTTPS. Tokens for accounts you connect are encrypted with AES-256-GCM under a key that is not the database password.",
  },
  {
    title: "Your Mac, on purpose",
    body: "Local Mode is off until you turn it on. Destructive commands ask before they run. Files on disk stay on disk unless you ask LYKN to use them.",
  },
  {
    title: "Payments stay with Stripe",
    body: "Card numbers go to Stripe, not to LYKN. We keep the customer and subscription ids needed to run your plan.",
  },
] as const;

const TOPICS = [
  {
    q: "What does LYKN store?",
    a: "Your account (email and sign-in method), chats, Markdown Memory, Vault items, projects, and files you save in LYKN. Those live in LYKN's cloud (Supabase, hosted in the US). Usage records needed to meter the product live there too.",
  },
  {
    q: "What stays on my computer?",
    a: "Local Mode settings, the folders you choose to sync, Home wallpaper copies, and the desktop app itself. Uninstalling the app does not delete your cloud account. We cannot reach in and wipe files on your Mac.",
  },
  {
    q: "When does information leave my computer?",
    a: "When you chat, attach a file, use Glass on a screen or with voice, search the web, or let the browser agent work a page. The pieces needed for that request go to LYKN's API, then to the model or search provider handling it. Idle Glass does not stream your desktop.",
  },
  {
    q: "Who can access my information?",
    a: "You, through your signed-in account. LYKN's servers use a service role that is scoped in application code to your user id. Model providers see the prompt, attachments, and tool results for a turn you started. Connected apps see only what that connection is for.",
  },
  {
    q: "Does LYKN sell my data?",
    a: "No. LYKN does not sell, rent, or trade your content, and it does not run ads against it.",
  },
  {
    q: "Is my data used to train AI models?",
    a: "LYKN does not put your chats into a shared training set for other customers. If you build a custom model, that path can use content you select and send it to Together AI. What OpenAI, Anthropic, Google, xAI, or others keep on their side is governed by their terms, not a flag we can fully control in the product today.",
  },
  {
    q: "What can the desktop agent access?",
    a: "Nothing on disk until Local Mode is on. After that, it can read and write inside the folders you synced, and it can run shell commands. Risky commands (delete, download, clone) ask first. The owned browser can open websites you send it to, including after you sync cookies. That is not a locked-down site list.",
  },
  {
    q: "What happens when I connect another service?",
    a: "LYKN stores an encrypted token and uses it to do the job you asked for. Disconnecting removes that token. The other service then follows its own privacy rules for anything it already received.",
  },
  {
    q: "What happens when I delete something?",
    a: "Deleting a note or chat removes it from your account. Deleting the account is a hard delete on LYKN: auth user, cascaded database rows, and files under your storage folder, plus a best-effort Stripe cancel. Copies that already went to a model provider, Stripe, or a connected app are not pulled back. Email privacy@lykn.io if you need help.",
  },
] as const;

const DOCS = [
  {
    title: "Privacy Policy",
    body: "What we collect, why we collect it, and how to ask us to delete it.",
    to: "/privacy",
  },
  {
    title: "Data Processing Agreement",
    body: "GDPR terms for EU and UK customers who route personal data through LYKN.",
    to: "/dpa",
  },
  {
    title: "Terms of Service",
    body: "The agreement that covers using LYKN, Glass, and connected tools.",
    to: "/terms",
  },
  {
    title: "Cookie Policy",
    body: "How cookies and similar technology work on the LYKN site.",
    to: "/cookies",
  },
] as const;

export default function Security() {
  const navigate = useNavigate();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="glass-land lx-sec-page">
      <LandingHeader />
      <main className="lx-sec">
        <div className="lx-sec-inner">
          <header className="lx-sec-hero">
            <p className="lx-sec-kicker">Security</p>
            <h1 className="lx-sec-title">Built to stay private.</h1>
            <p className="lx-sec-lede">
              LYKN runs on your Mac and in the cloud. Work you save in LYKN
              lives in your account. Files on your computer stay there unless
              you ask LYKN to use them.
            </p>
            <div className="lx-sec-ctas">
              <button
                type="button"
                className="lkn-nav-signup"
                onClick={() => navigate("/download")}
                aria-label="Download LYKN"
              >
                Download <LyknWordmark decorative />
              </button>
            </div>
          </header>

          <ul className="lx-sec-grid">
            {POINTS.map((point) => (
              <li key={point.title} className="lx-sec-card">
                <h2>{point.title}</h2>
                <p>{point.body}</p>
              </li>
            ))}
          </ul>

          <section className="lx-sec-topics" aria-label="How LYKN handles your data">
            <p className="lx-sec-kicker">How it works</p>
            <h2 className="lx-sec-docs-title">Plain answers.</h2>
            <dl className="lx-sec-qa">
              {TOPICS.map((topic) => (
                <div key={topic.q} className="lx-sec-qa-item">
                  <dt>{topic.q}</dt>
                  <dd>{topic.a}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="lx-sec-docs" aria-label="Security documents">
            <p className="lx-sec-kicker">Documents</p>
            <h2 className="lx-sec-docs-title">The policies, in full.</h2>
            <p className="lx-sec-docs-lede">
              Legal pages for privacy, processing, terms, and cookies.
            </p>
            <div className="lx-sec-grid">
              {DOCS.map((doc) => (
                <Link key={doc.to} to={doc.to} className="lx-sec-card lx-sec-doc">
                  <h3>{doc.title}</h3>
                  <p>{doc.body}</p>
                  <span className="lx-sec-doc-go">
                    Read <span aria-hidden="true">→</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>

          <p className="lx-sec-contact">
            Questions about security or data requests:{" "}
            <a href="mailto:privacy@lykn.io">privacy@lykn.io</a>
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
