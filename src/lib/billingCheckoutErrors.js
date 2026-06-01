import { CONNECTION_TROUBLE_TEXT } from "@/lib/ai/userFacingErrors";

const BILLING_CHECKOUT_ERRORS = {
  stripe_not_configured:
    "Checkout is not available right now. Please try again in a few minutes.",
  price_not_configured:
    "Checkout is not available right now. Please try again in a few minutes.",
  checkout_failed: CONNECTION_TROUBLE_TEXT,
  already_subscribed: null,
};

/** Map trial/billing checkout API errors to safe user-facing copy. */
export function toBillingCheckoutError(err) {
  const code = err?.code || err?.error;
  if (code && Object.prototype.hasOwnProperty.call(BILLING_CHECKOUT_ERRORS, code)) {
    return BILLING_CHECKOUT_ERRORS[code] || CONNECTION_TROUBLE_TEXT;
  }
  return CONNECTION_TROUBLE_TEXT;
}
