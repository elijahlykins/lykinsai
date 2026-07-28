// ============================================================================
// Billing success landing at /billing/success — the Stripe `success_url` for
// checkouts started from the iOS app (server.js /api/billing/checkout,
// `source: "ios"`).
//
// The path is whitelisted in the AASA file, but iOS does not fire universal
// links on Safari's redirect from Stripe — only on a real user tap. The
// "Open LYKN" button therefore uses the app's custom scheme with a lykn.io
// host (`lykn://lykn.io/billing/success`), which the app's DeepLinkRouter
// parses identically to the https form. Keep this page outside every auth and
// subscription gate: the Safari session may be signed out even though the
// purchase succeeded.
// ============================================================================

import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";

const APP_RETURN_URL = "lykn://lykn.io/billing/success";

export default function BillingSuccess() {
  return (
    <main className="min-h-screen bg-white dark:bg-zinc-950 text-black/90 dark:text-white/90 flex items-center justify-center px-5">
      <div className="max-w-md w-full text-center space-y-6 py-16">
        <CheckCircle2 className="h-12 w-12 mx-auto text-emerald-500" aria-hidden="true" />
        <h1 className="text-[32px] font-semibold tracking-[-0.02em] leading-[1.1]">
          You&rsquo;re all set
        </h1>
        <p className="text-[14px] leading-relaxed text-black/65 dark:text-white/70">
          Your subscription is active. Head back to the LYKN app to keep going
          &mdash; your new plan is ready there.
        </p>
        <a
          href={APP_RETURN_URL}
          className="inline-flex items-center justify-center rounded-full bg-blue-600 hover:bg-blue-500 text-white text-[14px] font-semibold px-6 py-3 transition-colors"
        >
          Open LYKN
        </a>
        <p className="text-[12.5px] text-black/45 dark:text-white/45">
          On the web instead?{" "}
          <Link to="/billing" className="underline hover:opacity-80 transition-opacity">
            Manage your plan
          </Link>
        </p>
      </div>
    </main>
  );
}
