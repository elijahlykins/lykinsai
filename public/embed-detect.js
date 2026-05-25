// Detects the `?embedded=1` query param the moment the document starts
// parsing, so embedding hosts (Notion, Loom, etc.) get the transparent
// theme on the very first paint. Moved out of an inline <script> in
// index.html so the frontend Content-Security-Policy can enforce
// `script-src 'self'` without 'unsafe-inline'. See SECURITY_REPORT_01.md.
if (location.search.includes('embedded=1')) {
  document.documentElement.classList.add('embedded-transparent');
}
