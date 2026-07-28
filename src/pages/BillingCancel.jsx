// ============================================================================
// Billing cancel landing at /billing/cancel — the Stripe `cancel_url` for
// checkouts started from the iOS app (server.js /api/billing/checkout,
// `source: "ios"`).
//
// Mirrors BillingSuccess.jsx: AASA whitelists the path, but re-entering the
// app needs a real tap, so the button uses the custom-scheme form the app's
// DeepLinkRouter already parses. No purchase happened, so the copy stays
// neutral — no retry pressure (the app shows its own upgrade surface). Keep
// outside every auth and subscription gate.
// ============================================================================

import { Link } from "react-router-dom";

const APP_RETURN_URL = "lykn://lykn.io/billing/cancel";

export default function BillingCancel() {
  return (
    <main className="min-h-screen bg-white dark:bg-zinc-950 text-black/90 dark:text-white/90 flex items-center justify-center px-5">
      <div className="max-w-md w-full text-center space-y-6 py-16">
        <h1 className="text-[32px] font-semibold tracking-[-0.02em] leading-[1.1]">
          Checkout canceled
        </h1>
        <p className="text-[14px] leading-relaxed text-black/65 dark:text-white/70">
          No charge was made. You can head back to the LYKN app, or pick a plan
          again anytime.
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
            Back to plans
          </Link>
        </p>
      </div>
    </main>
  );
}
