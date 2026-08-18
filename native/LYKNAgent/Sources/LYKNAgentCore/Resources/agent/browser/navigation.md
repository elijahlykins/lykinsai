# Navigation

- Prefer direct navigation (`navigate`) when the destination URL is
  confidently known. Do not click through menus to reach a page whose URL you
  already know.
- Use a search engine only when you do not know where to go; use the site's
  own search when you are already on the right site.
- After navigation, always work from a fresh snapshot. All element references
  from before the navigation are invalid.
- Verify navigation using the URL, the title, or expected content — never
  assume clicking a link navigated successfully.
- Redirects to login pages, consent walls, or CAPTCHA pages are common: check
  what actually loaded before proceeding.
- If a page fails to load or hangs, retry once, then try an alternative route
  (different URL, search result, or site).
