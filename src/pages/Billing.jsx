import { useState, useCallback, useEffect } from "react";
import { Check, Minus, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PLANS,
  FAQ_ITEMS,
  BILLING_PERIODS,
  getDisplayPrice,
  getAnnualSavings,
  isStudentEmail,
} from "@/lib/pricing-config";
import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { toUserFacingError } from "@/lib/ai/userFacingErrors";
import { toast } from "@/components/ui/use-toast";

function BillingToggle({ period, onChange }) {
  return (
    <div className="inline-flex rounded-md border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.06] p-[3px]">
      {[
        { key: BILLING_PERIODS.MONTHLY, label: "Monthly" },
        { key: BILLING_PERIODS.ANNUAL, label: "Annual" },
      ].map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={`relative px-3 py-1 text-xs font-medium rounded transition-all duration-200 ${
            period === opt.key
              ? "bg-white dark:bg-neutral-100 text-black/85 dark:text-neutral-900 shadow-sm"
              : "text-black/40 dark:text-white/45 hover:text-black/60 dark:hover:text-white/70"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function PriceDisplay({ plan, period }) {
  const price = getDisplayPrice(plan, period);
  const savings = getAnnualSavings(plan);
  const isAnnual = period === BILLING_PERIODS.ANNUAL;

  return (
    <div className="mt-3 mb-4">
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tracking-tight text-black/90 dark:text-white">
          ${price === 0 ? "0" : price % 1 === 0 ? price : price.toFixed(2)}
        </span>
        <span className="text-xs text-black/35 dark:text-white/45 font-medium">/mo</span>
      </div>
      {isAnnual && savings > 0 && (
        <p className="text-xs text-black/55 dark:text-white/55 font-medium mt-1">
          Save ${savings}/year
        </p>
      )}
    </div>
  );
}

function FeatureList({ features }) {
  return (
    <ul className="space-y-2 flex-1">
      {features.map((f, i) => (
        <li key={i} className="flex items-start gap-2">
          {f.included ? (
            <div className="w-4 h-4 rounded-full bg-black/[0.06] dark:bg-white/[0.10] flex items-center justify-center flex-shrink-0 mt-0.5">
              <Check className="w-2.5 h-2.5 text-black/70 dark:text-white/80" strokeWidth={3} />
            </div>
          ) : (
            <div className="w-4 h-4 rounded-full bg-black/[0.03] dark:bg-white/[0.06] flex items-center justify-center flex-shrink-0 mt-0.5">
              <Minus className="w-2.5 h-2.5 text-black/20 dark:text-white/25" strokeWidth={2} />
            </div>
          )}
          <div className="min-w-0">
            <span
              className={`text-xs leading-snug ${
                f.accent
                  ? "text-black/85 dark:text-white/90 font-medium"
                  : f.included
                  ? "text-black/70 dark:text-white/75"
                  : "text-black/30 dark:text-white/35"
              }`}
            >
              {f.text}
            </span>
            {f.note && (
              <span className="text-[10px] text-black/30 dark:text-white/35 block mt-0.5">
                {f.note}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PlanCard({
  plan,
  period,
  currentPlan,
  onCheckout,
  busy,
  waitlistState,
  onJoinWaitlist,
  /** When set, the CTA is disabled and this short label replaces it. */
  lockedLabel,
}) {
  const isLocked = Boolean(lockedLabel);
  const isCheckoutPlan = plan.checkout !== false;
  const isCurrent =
    plan.id === currentPlan ||
    (plan.id === "studio" &&
      (currentPlan === "studio" ||
        currentPlan === "studio_pro" ||
        currentPlan === "studio_max"));
  const isBusy = busy === plan.id;
  const isWaitlistCard = plan.comingSoon;
  const hasJoinedWaitlist = isWaitlistCard && Boolean(waitlistState?.joined);
  const waitlistBusy = isWaitlistCard && Boolean(waitlistState?.busy);
  const ctaStyles = {
    outline:
      "border border-black/10 dark:border-white/20 text-black/70 dark:text-white/80 hover:bg-black/[0.03] dark:hover:bg-white/[0.08] hover:border-black/15 dark:hover:border-white/30",
    default:
      "bg-black/90 dark:bg-white text-white dark:text-black hover:bg-black/80 dark:hover:bg-white/90",
    primary:
      "bg-black dark:bg-white text-white dark:text-black hover:bg-black/85 dark:hover:bg-white/90 shadow-sm",
  };

  return (
    // No initial/animate here — the grid wrapper in the page runs the (staggered)
    // entry animation; doubling it made each card fade/slide twice. h-full so
    // all three cards stretch to the tallest and CTAs align at the bottom.
    <motion.div
      className={`relative flex h-full flex-col rounded-2xl border p-5 transition-shadow duration-300 ${
        plan.highlighted
          ? "border-black/15 dark:border-white/25 bg-white dark:bg-neutral-900 shadow-xl shadow-black/[0.06] dark:shadow-black/40 ring-1 ring-black/[0.06] dark:ring-white/10"
          : "border-black/[0.06] dark:border-white/[0.12] bg-white dark:bg-neutral-900 shadow-sm dark:shadow-black/30 hover:shadow-md"
      } ${plan.comingSoon ? "opacity-[0.88]" : ""}`}
    >
      {plan.comingSoon && (
        <div className="absolute top-4 right-4">
          <span className="text-[10px] font-bold uppercase tracking-widest text-black/55 dark:text-white/60 bg-black/[0.04] dark:bg-white/[0.08] px-2.5 py-1 rounded-full">
            Coming Soon
          </span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-black/85 dark:text-white/90">{plan.name}</h3>
        {plan.badge && (
          <span className="text-[11px] font-semibold text-black/75 dark:text-white/85 bg-black/[0.06] dark:bg-white/[0.10] px-2 py-0.5 rounded-md">
            {plan.badge}
          </span>
        )}
      </div>

      <p className="text-xs text-black/40 dark:text-white/45 mt-1 leading-relaxed">
        {plan.tagline}
      </p>

      {plan.comingSoon ? (
        <div className="mt-3 mb-4">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold tracking-tight text-black/40 dark:text-white/45">
              —
            </span>
          </div>
          <p className="text-xs text-black/35 dark:text-white/45 font-medium mt-1">
            Pricing to be announced
          </p>
        </div>
      ) : (
        <PriceDisplay plan={plan} period={period} />
      )}

      <FeatureList features={plan.features} />

      <button
        onClick={() => {
          if (isWaitlistCard) {
            if (!hasJoinedWaitlist) onJoinWaitlist?.(plan.id);
            return;
          }
          if (!isCheckoutPlan || isLocked) return;
          onCheckout(plan.id);
        }}
        disabled={
          isCurrent ||
          isBusy ||
          !isCheckoutPlan ||
          isLocked ||
          (isWaitlistCard ? hasJoinedWaitlist || waitlistBusy : false)
        }
        className={`mt-4 w-full py-2 px-3 rounded-lg text-xs font-semibold transition-all duration-200 cursor-pointer disabled:cursor-default ${
          isCurrent
            ? "border border-black/10 dark:border-white/20 text-black/40 dark:text-white/45 bg-black/[0.02] dark:bg-white/[0.04]"
            : hasJoinedWaitlist
              ? "border border-black/10 dark:border-white/20 bg-black/[0.04] dark:bg-white/[0.08] text-black/70 dark:text-white/80"
              : !isCheckoutPlan
                ? "border border-black/10 dark:border-white/20 text-black/40 dark:text-white/45 bg-black/[0.02] dark:bg-white/[0.04]"
              : `${ctaStyles[plan.ctaVariant]} disabled:opacity-60`
        }`}
      >
        {isCurrent
          ? "Current Plan"
          : isLocked
            ? lockedLabel
          : isWaitlistCard
            ? hasJoinedWaitlist
              ? "You're on the waitlist"
              : waitlistBusy
                ? "Adding you…"
                : plan.cta
            : !isCheckoutPlan
              ? plan.cta
            : isBusy
              ? "Redirecting…"
              : plan.cta}
      </button>
      {isLocked && !isCurrent && (
        <p className="mt-2 text-[10px] text-black/40 dark:text-white/45 text-center">
          Sign up with your school email (.edu / .ac) to unlock the student price.
        </p>
      )}
      {isWaitlistCard && hasJoinedWaitlist && (
        <p className="mt-2 text-[10px] text-black/40 dark:text-white/45 text-center">
          We'll email you when {plan.name} goes live.
        </p>
      )}
    </motion.div>
  );
}

function FAQItem({ item, isOpen, onToggle }) {
  const itemId = item.id || item.question.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const buttonId = `billing-faq-button-${itemId}`;
  const panelId = `billing-faq-panel-${itemId}`;

  return (
    <div className="border-b border-black/[0.05] dark:border-white/[0.10] last:border-0">
      <button
        type="button"
        onClick={onToggle}
        id={buttonId}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="w-full flex items-center justify-between py-4 text-left group"
      >
        <span className="text-sm font-medium text-black/75 dark:text-white/80 group-hover:text-black/90 dark:group-hover:text-white transition-colors pr-4">
          {item.question}
        </span>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0"
        >
          <ChevronDown className="w-4 h-4 text-black/30 dark:text-white/45" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            className="overflow-hidden"
          >
            <p className="text-sm text-black/50 dark:text-white/60 leading-relaxed pb-4">
              {item.answer}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function postBilling(path, body) {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(
      new Error(json?.message || json?.error || `Request failed: ${res.status}`),
      { code: json?.error },
    );
    throw err;
  }
  return json;
}

export default function Billing() {
  const { user } = useAuth();
  const [period, setPeriod] = useState(BILLING_PERIODS.ANNUAL);
  const [openFaq, setOpenFaq] = useState(null);
  const [currentPlan, setCurrentPlan] = useState("free");
  const [billingMeta, setBillingMeta] = useState({
    hasActiveSubscription: false,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
  });
  const [checkoutBusy, setCheckoutBusy] = useState(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [waitlistState, setWaitlistState] = useState({ joined: false, busy: false });

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const headers = await authHeaders();

      const billing = fetch(`${API_BASE_URL}/api/billing/me`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const waitlist = fetch(`${API_BASE_URL}/api/billing/waitlist`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const [billingData, waitlistData] = await Promise.all([
        billing,
        waitlist,
      ]);

      if (cancelled) return;
      if (billingData) {
        setCurrentPlan(billingData.plan || "free");
        setBillingMeta({
          hasActiveSubscription: Boolean(billingData.has_active_subscription),
          cancelAtPeriodEnd: Boolean(billingData.cancel_at_period_end),
          currentPeriodEnd: billingData.current_period_end || null,
        });
      }
      if (waitlistData) {
        setWaitlistState((prev) => ({
          ...prev,
          joined: Boolean(waitlistData.joined),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Surface the result of a Stripe redirect (?checkout=success, etc.) and
  // clean the URL so a refresh doesn't re-trigger the toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;

    if (checkout === "success") {
      // The Stripe webhook updates billing asynchronously, so a single
      // immediate poll often still sees the old plan and the page keeps
      // showing "Free" until a manual refresh. Poll a few times with
      // backoff until the plan flips away from free (or we give up).
      let cancelled = false;
      (async () => {
        for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
          try {
            const headers = await authHeaders();
            const r = await fetch(`${API_BASE_URL}/api/billing/me`, { headers });
            const data = await r.json();
            if (cancelled) return;
            if (data?.plan) {
              setCurrentPlan(data.plan);
              if (data.plan !== "free") return;
            }
          } catch {
            /* transient — retry below */
          }
          await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        }
      })();
      const url = new URL(window.location.href);
      url.searchParams.delete("checkout");
      url.searchParams.delete("session_id");
      window.history.replaceState({}, "", url.toString());
      return () => {
        cancelled = true;
      };
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("checkout");
    url.searchParams.delete("session_id");
    window.history.replaceState({}, "", url.toString());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const scrollToFaq = () => {
      if (window.location.hash !== "#faq") return;
      window.requestAnimationFrame(() => {
        const faq = document.getElementById("faq");
        if (!faq) return;
        setOpenFaq((prev) => (prev == null ? 0 : prev));
        faq.scrollIntoView({ behavior: "smooth", block: "start" });
        faq.focus({ preventScroll: true });
      });
    };

    scrollToFaq();
    window.addEventListener("hashchange", scrollToFaq);
    return () => window.removeEventListener("hashchange", scrollToFaq);
  }, []);

  const handleCheckout = useCallback(
    async (planId) => {
      if (planId === currentPlan) return;
      setCheckoutBusy(planId);
      try {
        // The iOS app opens /billing?source=ios; Login preserves the query
        // through its auth bounce. Forwarding it lets the server point
        // Stripe's return at the app's universal-link paths.
        const source =
          new URLSearchParams(window.location.search).get("source") === "ios"
            ? "ios"
            : undefined;
        const { url } = await postBilling("/api/billing/checkout", { planId, period, source });
        if (url) window.location.href = url;
      } catch (err) {
        if (err?.code === "student_email_required") {
          toast({
            variant: "destructive",
            title: "Student plan needs a school email",
            description:
              err.message ||
              "Your account email must be a school address (like name@university.edu) to get the student price.",
          });
          return;
        }
        // Existing subscribers change plans via the Stripe billing portal —
        // the server refuses Checkout for them so we never create a second,
        // parallel subscription. Send them straight to the portal instead.
        if (err?.code === "already_subscribed") {
          try {
            const { url } = await postBilling("/api/billing/portal");
            if (url) {
              window.location.href = url;
              return;
            }
          } catch (portalErr) {
            console.error("[Billing] portal redirect failed:", portalErr);
          }
        }
        console.error("[Billing] checkout failed:", err);
        toast({ variant: "destructive", title: "Checkout failed", description: toUserFacingError(err) });
      } finally {
        setCheckoutBusy(null);
      }
    },
    [currentPlan, period],
  );

  const handleJoinWaitlist = useCallback(async () => {
    if (waitlistState.joined || waitlistState.busy) return;
    setWaitlistState((prev) => ({ ...prev, busy: true }));
    try {
      const body = user?.email ? { email: user.email } : {};
      const data = await postBilling("/api/billing/waitlist", body);
      setWaitlistState({ joined: Boolean(data?.joined), busy: false });
    } catch (err) {
      console.error("[Billing] waitlist join failed:", err);
      toast({ variant: "destructive", title: "Couldn't join the waitlist", description: toUserFacingError(err) });
      setWaitlistState((prev) => ({ ...prev, busy: false }));
    }
  }, [user?.email, waitlistState.joined, waitlistState.busy]);

  const handleCancelSubscription = useCallback(async () => {
    if (portalBusy) return;
    setPortalBusy(true);
    try {
      const { url } = await postBilling("/api/billing/portal", { flow: "cancel" });
      if (url) window.location.href = url;
    } catch (err) {
      console.error("[Billing] cancel portal failed:", err);
      toast({
        variant: "destructive",
        title: "Couldn't open cancel flow",
        description: toUserFacingError(err),
      });
      setPortalBusy(false);
    }
  }, [portalBusy]);

  const toggleFaq = useCallback(
    (idx) => setOpenFaq((prev) => (prev === idx ? null : idx)),
    []
  );

  const periodEndLabel = billingMeta.currentPeriodEnd
    ? new Date(billingMeta.currentPeriodEnd).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="min-h-screen bg-transparent text-black dark:text-white">
      <div className="max-w-6xl mx-auto px-6 py-10">
        {/* Hero */}
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-black/90 dark:text-white tracking-tight">
            Pick the plan that fits how you work
          </h2>
          <p className="text-base text-black/45 dark:text-white/60 mt-3 max-w-lg mx-auto leading-relaxed">
            You're already on Free with the full app. Go Pro for every model and
            an unlimited workspace, get the same on the Student plan for $20/mo
            ($12/mo billed annually), or go Max to remove the monthly usage caps
            entirely. Cancel anytime, no hidden fees.
          </p>
        </div>

        {/* Current-plan banner — make the free tier visible */}
        {currentPlan === "free" && (
          <div className="max-w-3xl mx-auto mb-6">
            <div className="flex flex-col gap-1 rounded-xl border border-black/[0.08] dark:border-white/[0.12] bg-black/[0.02] dark:bg-white/[0.04] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <p className="text-sm text-black/70 dark:text-white/75">
                You're on the{" "}
                <span className="font-semibold text-black/90 dark:text-white">Free</span>{" "}
                plan: the full app with capped limits, 100 synthesis neurons, 50
                Vault cards, LYKN's core models, and monthly usage caps on Glass,
                image generation, and artifact builds.
              </p>
              <span className="flex-shrink-0 text-xs font-medium text-black/45 dark:text-white/55">
                Upgrade for unlimited everything →
              </span>
            </div>
          </div>
        )}

        {billingMeta.hasActiveSubscription && (
          <div className="max-w-3xl mx-auto mb-6">
            <div className="flex flex-col gap-3 rounded-xl border border-black/[0.08] dark:border-white/[0.12] bg-black/[0.02] dark:bg-white/[0.04] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm text-black/70 dark:text-white/75">
                  {billingMeta.cancelAtPeriodEnd ? (
                    <>
                      Your subscription is set to cancel
                      {periodEndLabel ? <> on <span className="font-semibold text-black/90 dark:text-white">{periodEndLabel}</span></> : null}.
                      You'll keep access until then.
                    </>
                  ) : (
                    <>
                      Need to leave? Cancel anytime — you'll keep access through the
                      end of your current billing period.
                    </>
                  )}
                </p>
              </div>
              {!billingMeta.cancelAtPeriodEnd && (
                <button
                  type="button"
                  onClick={handleCancelSubscription}
                  disabled={portalBusy}
                  className="flex-shrink-0 text-sm font-medium text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50 transition-colors"
                >
                  {portalBusy ? "Opening…" : "Cancel subscription"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Toggle + Plan Cards */}
        <div className="max-w-6xl mx-auto">
        <div className="mb-5 text-center">
          <BillingToggle period={period} onChange={setPeriod} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-16">
          {PLANS.map((plan, i) => (
            <motion.div
              key={plan.id}
              className="h-full"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
            >
              <PlanCard
                plan={plan}
                period={period}
                currentPlan={currentPlan}
                onCheckout={handleCheckout}
                busy={checkoutBusy}
                waitlistState={waitlistState}
                onJoinWaitlist={handleJoinWaitlist}
                lockedLabel={
                  // Student plan needs a school account email; the server
                  // enforces this on checkout (student_email_required).
                  plan.id === "student" &&
                  currentPlan !== "student" &&
                  !isStudentEmail(user?.email)
                    ? "Requires a school email"
                    : null
                }
              />
            </motion.div>
          ))}
        </div>
        </div>

        {/* FAQ */}
        <div
          id="faq"
          tabIndex={-1}
          aria-labelledby="billing-faq-heading"
          className="max-w-2xl mx-auto mb-16 scroll-mt-8 focus:outline-none"
        >
          <h3
            id="billing-faq-heading"
            className="text-xl font-semibold text-black/85 dark:text-white/90 text-center mb-8"
          >
            Frequently asked questions
          </h3>
          <div className="rounded-2xl bg-white dark:bg-neutral-900 border border-black/[0.06] dark:border-white/[0.12] shadow-sm dark:shadow-black/30 p-6">
            {FAQ_ITEMS.map((item, i) => (
              <FAQItem
                key={item.id || item.question}
                item={item}
                isOpen={openFaq === i}
                onToggle={() => toggleFaq(i)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
