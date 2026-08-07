// Google Analytics Consent Mode bootstrap.
// Kept as a same-origin file (not inline) so CSP can stay script-src without
// 'unsafe-inline'. External gtag.js + connect endpoints are allowlisted in
// vercel.json.
window.dataLayer = window.dataLayer || [];
function gtag() {
  dataLayer.push(arguments);
}
gtag("consent", "default", {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
  wait_for_update: 500,
});
gtag("js", new Date());
// send_page_view false: React Router emits page_view on each route change.
gtag("config", "G-Q4KSD1G8YF", { anonymize_ip: true, send_page_view: false });
