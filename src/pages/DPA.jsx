// ============================================================================
// DPA, Data Processing Agreement at /dpa
// ============================================================================
// Required by:
//   • GDPR Article 28, written contract any time an EU/UK customer (the
//     "controller") routes personal data through a processor (LYKN).
//   • UK GDPR + DPA 2018, same requirement.
//   • Many enterprise procurement teams gate purchase on a signed DPA even
//     where one isn't strictly legally required.
//
// This is a STANDALONE addendum to the Terms of Service. It auto-applies
// to any customer who routes personal data of EU/UK data subjects through
// LYKN. No separate signature flow is required for self-serve plans, the
// click-through on /terms incorporates this DPA by reference (see Terms
// §Connected AI tools / your content).
//
// For enterprise customers who need an executed copy or to negotiate
// variations (extra sub-processors, audit rights, custom SCCs), email
// privacy@lykn.io and we'll produce an exhibit.
//
// Lawyer review status: NOT YET RUN BY COUNSEL. v1 draft based on the
// IAPP DPA template + Article 28 mandatory clauses + the EU 2021/914 SCCs
// Module Two (Controller → Processor). Before any enterprise deal that
// requires negotiated terms, run this past an attorney.
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft, ShieldAlert } from "lucide-react";

const LAST_UPDATED = "July 21, 2026";

export default function DPA() {
  return (
    <main className="min-h-screen bg-white dark:bg-zinc-950 text-black/90 dark:text-white/90">
      <nav className="sticky top-0 z-30 backdrop-blur-md bg-white/70 dark:bg-zinc-950/70 border-b border-black/[0.06] dark:border-white/[0.06]">
        <div className="max-w-3xl mx-auto px-5 py-3 flex items-center justify-between">
          <Link
            to="/"
            className="text-[13px] font-semibold tracking-tight inline-flex items-center gap-1.5 hover:opacity-80 transition-opacity"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            LYKN
          </Link>
          <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45">
            Data Processing Agreement
          </div>
        </div>
      </nav>

      <article className="max-w-2xl mx-auto px-5 py-16 space-y-8">
        <header>
          <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
            Effective {LAST_UPDATED}
          </div>
          <h1 className="text-[40px] font-semibold tracking-[-0.02em] leading-[1.05]">
            Data Processing Agreement
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-black/65 dark:text-white/70">
            This Data Processing Agreement ("DPA") forms part of the LYKN{" "}
            <Link
              to="/terms"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Terms of Service
            </Link>{" "}
            between you (the "Customer", acting as data{" "}
            <strong>controller</strong>) and{" "}
            <strong>Omnia Technologies LLC</strong>, a Utah limited liability
            company operating LYKN ("LYKN", acting as data{" "}
            <strong>processor</strong>). It applies whenever LYKN processes
            personal data on your behalf in connection with the LYKN service.
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-black/55 dark:text-white/60">
            For self-serve plans the click-through on{" "}
            <Link
              to="/terms"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              /terms
            </Link>{" "}
            incorporates this DPA by reference; no separate signature is
            required. Enterprise customers who require an executed copy may
            email{" "}
            <a
              href="mailto:privacy@lykn.io"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              privacy@lykn.io
            </a>
            .
          </p>
        </header>

        <Section title="1. Definitions" anchor="definitions">
          <p>
            Capitalised terms not defined here have the meaning given in the
            GDPR (Regulation (EU) 2016/679) or the UK GDPR. In particular:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              <strong>"Personal Data"</strong> means any information relating
              to an identified or identifiable natural person that Customer
              uploads, generates, or transmits through the LYKN service.
            </Bullet>
            <Bullet>
              <strong>"Processing"</strong> means any operation performed on
              Personal Data: collection, storage, retrieval, use, disclosure,
              erasure, etc.
            </Bullet>
            <Bullet>
              <strong>"Sub-processor"</strong> means any third party engaged
              by LYKN to Process Personal Data on Customer's behalf.
            </Bullet>
            <Bullet>
              <strong>"Data Subject"</strong> means the individual to whom the
              Personal Data relates, typically Customer's end users.
            </Bullet>
            <Bullet>
              <strong>"Applicable Data Protection Law"</strong> means the
              GDPR, the UK GDPR, the UK Data Protection Act 2018, the
              California Consumer Privacy Act / CPRA, and any other privacy
              or data-protection law applicable to the Processing.
            </Bullet>
          </ul>
        </Section>

        <Section title="2. Roles and scope" anchor="roles">
          <p>
            Customer is the <strong>controller</strong> of Personal Data
            Processed through LYKN. LYKN is the <strong>processor</strong>{" "}
            acting only on Customer's documented instructions. The Terms of
            Service, this DPA, and Customer's use of the LYKN UI and APIs
            constitute Customer's documented instructions.
          </p>
          <p className="mt-3">
            Where LYKN's own operational telemetry (server logs, usage
            counters, security signals) does not relate to Customer's
            Personal Data, LYKN acts as an independent controller for that
            limited data; see{" "}
            <Link
              to="/privacy"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Privacy Policy
            </Link>
            .
          </p>
        </Section>

        <Section title="3. Subject matter and details of Processing" anchor="processing-details">
          <p>This DPA describes the Processing as follows:</p>
          <table className="w-full text-[12.5px] mt-3 border-collapse">
            <tbody className="text-black/65 dark:text-white/70">
              <DetailRow
                label="Subject matter"
                value="Provision of the LYKN synthesis service and LYKN Glass desktop overlay: storing, retrieving, embedding, clustering, and serving Customer's vault content, beliefs, facts, project state, and conversations; processing feature-triggered screen stills, snips, page text, and voice audio; serving data to AI tools Customer has explicitly connected."
              />
              <DetailRow
                label="Duration"
                value="For the term of Customer's account, plus the retention windows in §10."
              />
              <DetailRow
                label="Nature and purpose"
                value="Hosting, search, semantic embedding, LLM-assisted synthesis and Glass features (chat, build, imagine, voice, screen-grounded assist), OAuth token issuance, billing/trial processing, transactional email, desktop auto-update distribution."
              />
              <DetailRow
                label="Categories of Data Subject"
                value="Customer's authorised users, plus any individual referenced in content Customer uploads or that appears in screen/audio captures Customer chooses to process (e.g. names in a note, faces/text on screen, voices on a call)."
              />
              <DetailRow
                label="Categories of Personal Data"
                value="Account identifiers (email, user id); vault content (notes, files, links, transcripts, artifacts); AI-derived beliefs, facts, rules, and project state; Glass overlay chats; feature-triggered screen stills/snips/page text and voice/system audio for Voice Mode and related features; OAuth client metadata; billing customer identifiers via Stripe; minimal usage telemetry."
              />
              <DetailRow
                label="Special-category data"
                value="LYKN does not request or require special-category data (Art. 9). If Customer chooses to upload such data into their vault, Customer warrants it has a valid Art. 9 lawful basis to do so."
              />
            </tbody>
          </table>
        </Section>

        <Section title="4. LYKN's obligations as processor" anchor="processor-obligations">
          <p>LYKN shall:</p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              Process Personal Data only on Customer's documented
              instructions, including with regard to international transfers,
              unless required to do otherwise by law (in which case LYKN will
              notify Customer first unless that notification is itself
              prohibited).
            </Bullet>
            <Bullet>
              Ensure that personnel authorised to Process Personal Data are
              bound by appropriate confidentiality obligations.
            </Bullet>
            <Bullet>
              Implement and maintain the technical and organisational
              measures described in §8 to ensure a level of security
              appropriate to the risk.
            </Bullet>
            <Bullet>
              Assist Customer (taking into account the nature of the
              Processing) in responding to Data Subject rights requests
              under Articles 12–22 GDPR, primarily through the in-product
              export and deletion features.
            </Bullet>
            <Bullet>
              Assist Customer in meeting its obligations under Articles 32–36
              GDPR (security, breach notification, DPIA, prior consultation)
              taking into account the information available to LYKN.
            </Bullet>
            <Bullet>
              At Customer's choice, delete or return all Personal Data after
              the end of the provision of services, and delete existing
              copies unless EU/Member State law requires storage. Default
              behaviour: hard deletion per §10.
            </Bullet>
            <Bullet>
              Make available to Customer all information necessary to
              demonstrate compliance with Article 28 and allow for and
              contribute to audits as set out in §9.
            </Bullet>
          </ul>
        </Section>

        <Section title="5. Customer's obligations as controller" anchor="controller-obligations">
          <p>Customer warrants and undertakes that it will:</p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              Have a valid lawful basis under Article 6 (and, where
              applicable, Article 9) GDPR for all Personal Data it routes
              through LYKN.
            </Bullet>
            <Bullet>
              Provide all transparency notices required by Articles 13 and 14
              GDPR to its Data Subjects.
            </Bullet>
            <Bullet>
              Issue instructions to LYKN only as permitted by Applicable Data
              Protection Law.
            </Bullet>
            <Bullet>
              Not upload Personal Data of children under the applicable age
              of digital consent without verifiable parental consent.
            </Bullet>
            <Bullet>
              Promptly handle any Data Subject request directed at Customer,
              and pass through only those parts requiring LYKN's assistance.
            </Bullet>
          </ul>
        </Section>

        <Section title="6. Sub-processors" anchor="sub-processors">
          <p>
            Customer grants LYKN <strong>general written authorisation</strong>{" "}
            to engage the sub-processors listed below, all of whom are bound
            by data-protection obligations no less protective than those in
            this DPA:
          </p>
          <table className="w-full text-[12.5px] mt-4 border-collapse">
            <thead>
              <tr className="border-b border-black/[0.08] dark:border-white/[0.1]">
                <th className="text-left py-2 pr-4 font-semibold">Sub-processor</th>
                <th className="text-left py-2 pr-4 font-semibold">Purpose</th>
                <th className="text-left py-2 font-semibold">Region</th>
              </tr>
            </thead>
            <tbody className="text-black/65 dark:text-white/70">
              <SubRow p="Supabase" purpose="Database, auth, file storage" region="US-East" />
              <SubRow p="Render" purpose="API / backend hosting" region="US-East" />
              <SubRow p="Vercel" purpose="Website and web app hosting (lykn.io)" region="Global edge" />
              <SubRow p="Anthropic" purpose="LLM inference (Claude tiers)" region="US" />
              <SubRow p="OpenAI" purpose="LLM inference (GPT tiers); embeddings; image/speech paths" region="US" />
              <SubRow p="Google" purpose="LLM/vision (Gemini tiers); Google OAuth for connectors Customer enables" region="US" />
              <SubRow p="xAI" purpose="LLM inference (Grok tiers)" region="US" />
              <SubRow p="ElevenLabs" purpose="Voice Mode audio processing" region="US" />
              <SubRow p="Resend" purpose="Transactional email" region="US" />
              <SubRow p="Stripe" purpose="Trials, subscriptions, invoices" region="US" />
              <SubRow p="GitHub" purpose="Desktop release / auto-update packages" region="US" />
            </tbody>
          </table>
          <p className="mt-4">
            LYKN will notify Customer of any intended addition or replacement
            of sub-processors at least 30 days in advance (by email to the
            account holder and an updated{" "}
            <Link
              to="/privacy#processors"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Privacy Policy §Where your data lives
            </Link>
            ). Customer may object to the change for documented
            data-protection reasons within 30 days; if the parties cannot
            agree, Customer's sole remedy is to terminate the affected
            services and receive a pro-rated refund of pre-paid fees.
          </p>
          <p className="mt-3">
            LYKN remains fully liable to Customer for the performance of any
            sub-processor's obligations.
          </p>
        </Section>

        <Section title="7. International transfers" anchor="transfers">
          <p>
            LYKN's infrastructure and sub-processors are predominantly US-based.
            Where Personal Data of EU/UK Data Subjects is transferred outside
            the EEA / UK, the transfer is made under:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              the <strong>EU Standard Contractual Clauses</strong> (Commission
              Implementing Decision (EU) 2021/914), Module Two (controller →
              processor), incorporated by reference into this DPA; and
            </Bullet>
            <Bullet>
              the <strong>UK International Data Transfer Addendum</strong> to
              the EU SCCs (issued by the ICO), where the data exporter is in
              the UK.
            </Bullet>
          </ul>
          <p className="mt-3">
            The optional clauses and dispute-resolution choices in the SCCs
            are completed as follows: Clause 7 (docking), not applicable;
            Clause 9(a), Option 2 (general written authorisation, 30 days);
            Clause 11(a), optional independent dispute resolution NOT
            selected; Clause 17 (governing law), Republic of Ireland;
            Clause 18 (forum), courts of Ireland. Annex I (parties and
            description of transfer) and Annex II (technical and
            organisational measures) are populated by §3 and §8 of this DPA.
            Annex III is the sub-processor list in §6.
          </p>
        </Section>

        <Section title="8. Security measures" anchor="security">
          <p>
            LYKN implements appropriate technical and organisational measures
            to protect Personal Data, including:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              <strong>Encryption in transit:</strong> TLS 1.2+ for all
              traffic to lykn.io and our API endpoints, with HSTS enforced.
            </Bullet>
            <Bullet>
              <strong>Encryption at rest:</strong> all Personal Data is
              encrypted at rest at the storage layer. OAuth tokens and
              third-party API credentials are additionally encrypted with
              AES-256-GCM using a separate key (CONNECTOR_TOKEN_KEY) before
              being written to the database.
            </Bullet>
            <Bullet>
              <strong>Access controls:</strong> Role-based access control on
              all admin surfaces. Row-level security in the database scopes
              every query to <code>auth.uid()</code>. Production secrets
              held in a managed secret store, never in source control.
            </Bullet>
            <Bullet>
              <strong>Authentication:</strong> OAuth 2.1 with PKCE for all
              external integrations. Refresh-token rotation with replay
              detection (RFC 6749 §10.4), a leaked refresh token revokes
              the entire token family on reuse.
            </Bullet>
            <Bullet>
              <strong>Logging and monitoring:</strong> Centralised
              application and access logs with anomaly detection. Logs
              contain user ids and endpoints, never request bodies.
            </Bullet>
            <Bullet>
              <strong>Backups:</strong> Encrypted at rest with separate
              keys; retained for up to 7 days; deleted accounts are purged
              from the next backup cycle.
            </Bullet>
            <Bullet>
              <strong>Vulnerability management:</strong> Dependency scanning
              on every commit; security patches applied on the supported
              cadence of upstream maintainers.
            </Bullet>
            <Bullet>
              <strong>Personnel:</strong> All personnel with access to
              production data are bound by written confidentiality
              obligations and receive periodic security training.
            </Bullet>
          </ul>
          <p className="mt-3">
            LYKN will review these measures periodically and may update
            them, provided the security level is not materially reduced.
          </p>
        </Section>

        <Section title="9. Audits" anchor="audits">
          <p>
            LYKN will make available to Customer, on reasonable written
            request, the information necessary to demonstrate compliance
            with this DPA, typically through (a) the security
            documentation summarised in §8, (b) the most recent independent
            security assessments of LYKN's sub-processors, and (c) written
            responses to Customer's questionnaire.
          </p>
          <p className="mt-3">
            Where Customer can demonstrate that the above is insufficient
            to meet a specific legal obligation, Customer may, no more than
            once per twelve-month period (or more often if required by a
            supervisory authority following a breach), conduct an on-site
            audit during business hours, on at least 30 days' written
            notice, by Customer or a mutually agreed independent auditor
            bound by confidentiality. Customer bears its own audit costs.
          </p>
        </Section>

        <Section title="10. Personal Data breaches" anchor="breach">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 mb-3 flex gap-2 items-start">
            <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <p className="text-[12.5px]">
              In the unlikely event of a Personal Data breach affecting
              Customer's data, LYKN's notification commitment is below.
            </p>
          </div>
          <p>
            LYKN will notify Customer without undue delay, and in any event
            within <strong>72 hours</strong> of becoming aware of a Personal
            Data breach affecting Customer's Personal Data, with the
            information then available, typically including (i) the nature
            of the breach, categories and approximate number of Data
            Subjects and records affected, (ii) the likely consequences,
            (iii) the measures taken or proposed, and (iv) a contact point
            for follow-up.
          </p>
          <p className="mt-3">
            Notification is not itself an acknowledgement of fault or
            liability. LYKN will cooperate with Customer's reasonable
            requests for further information and assist Customer in meeting
            its own breach-notification obligations to supervisory
            authorities and Data Subjects.
          </p>
        </Section>

        <Section title="11. Return and deletion" anchor="deletion">
          <p>
            On termination or expiry of the agreement, or on Customer's
            earlier written request, LYKN will, at Customer's choice:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              <strong>Return</strong> the Personal Data to Customer in a
              structured, commonly-used, machine-readable format (the
              in-product JSON export), and then delete it; or
            </Bullet>
            <Bullet>
              <strong>Delete</strong> the Personal Data without returning
              it.
            </Bullet>
          </ul>
          <p className="mt-3">
            Default behaviour on account deletion is the hard-delete path
            described in{" "}
            <Link
              to="/privacy#retention"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Privacy Policy §Retention
            </Link>{" "}
           , completed within 30 days, with backups purged within the
            7-day backup cycle. LYKN may retain Personal Data only to the
            extent and for as long as required by EU / Member State law, and
            will protect any such residual data with the measures in §8.
          </p>
        </Section>

        <Section title="12. Liability" anchor="liability">
          <p>
            Each party's liability arising out of or in connection with
            this DPA is subject to the limitations and exclusions of
            liability in the Terms of Service. For the avoidance of doubt,
            nothing in this DPA limits any liability that cannot be limited
            under Applicable Data Protection Law (including direct claims
            by Data Subjects under Article 82 GDPR).
          </p>
        </Section>

        <Section title="13. Order of precedence" anchor="precedence">
          <p>
            In the event of any conflict between this DPA and the Terms of
            Service in relation to the Processing of Personal Data, this DPA
            controls. The SCCs (where applicable per §7) prevail over both
            in the event of conflict.
          </p>
        </Section>

        <Section title="14. Term, changes, and governing law" anchor="term">
          <p>
            This DPA is effective for so long as LYKN Processes Personal
            Data on Customer's behalf. Material changes (new sub-processors,
            new categories of Processing, weakened security commitments)
            follow the 14-day email-notice rule in the Terms of Service.
          </p>
          <p className="mt-3">
            Governing law and dispute resolution follow the Terms of
            Service, except where Applicable Data Protection Law mandates
            otherwise (notably the SCCs at §7).
          </p>
        </Section>

        <Section title="15. Contact" anchor="contact">
          <p>
            Data-protection matters, breach notifications, and DPA
            negotiation requests:{" "}
            <a
              href="mailto:privacy@lykn.io"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              privacy@lykn.io
            </a>
            .
          </p>
        </Section>

        <footer className="pt-10 mt-10 border-t border-black/[0.06] dark:border-white/[0.08]">
          <div className="flex items-center justify-between text-[11.5px] text-black/55 dark:text-white/55">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-black/75 dark:text-white/75">LYKN</span>
            </div>
            <div className="flex gap-5">
              <Link to="/privacy" className="hover:text-black/85 dark:hover:text-white/85">
                Privacy
              </Link>
              <Link to="/terms" className="hover:text-black/85 dark:hover:text-white/85">
                Terms
              </Link>
              <Link to="/cookies" className="hover:text-black/85 dark:hover:text-white/85">
                Cookies
              </Link>
              <Link to="/" className="hover:text-black/85 dark:hover:text-white/85">
                Home
              </Link>
            </div>
          </div>
        </footer>
      </article>
    </main>
  );
}

function Section({ title, anchor, children }) {
  return (
    <section id={anchor} className="scroll-mt-20">
      <h2 className="text-[20px] font-semibold tracking-tight mb-3">{title}</h2>
      <div className="text-[13.5px] leading-relaxed text-black/70 dark:text-white/75 space-y-2">
        {children}
      </div>
    </section>
  );
}

function Bullet({ children }) {
  return (
    <li className="flex gap-2">
      <span className="text-emerald-500 mt-[1px]">•</span>
      <span>{children}</span>
    </li>
  );
}

function SubRow({ p, purpose, region }) {
  return (
    <tr className="border-b border-black/[0.05] dark:border-white/[0.05]">
      <td className="py-2 pr-4 font-medium text-black/85 dark:text-white/85 align-top">{p}</td>
      <td className="py-2 pr-4 align-top">{purpose}</td>
      <td className="py-2 align-top whitespace-nowrap">{region}</td>
    </tr>
  );
}

function DetailRow({ label, value }) {
  return (
    <tr className="border-b border-black/[0.05] dark:border-white/[0.05] align-top">
      <td className="py-2 pr-4 font-medium text-black/85 dark:text-white/85 w-[140px] align-top">
        {label}
      </td>
      <td className="py-2 align-top">{value}</td>
    </tr>
  );
}
