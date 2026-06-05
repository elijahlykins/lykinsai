function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slideHtml(sec, index, total) {
  const heading = sec.heading ? `<h2>${escapeHtml(sec.heading)}</h2>` : '';
  const body = sec.body
    ? `<div class="body">${escapeHtml(sec.body).replace(/\n/g, '<br/>')}</div>`
    : '';
  const notes = sec.notes ? `<aside class="notes">${escapeHtml(sec.notes)}</aside>` : '';
  return `<section class="slide" data-index="${index}">
    <div class="slide-inner">${heading}${body}${notes}</div>
    <footer>${index + 1} / ${total}</footer>
  </section>`;
}

/** Self-contained HTML slideshow — open file_url in browser to present. */
export function buildSlideshowHtml(title, sections, { templateType = 'slideshow' } = {}) {
  const items = Array.isArray(sections) ? sections : [];
  const slides = items.length
    ? items.map((sec, i) => slideHtml(sec, i, items.length)).join('\n')
    : slideHtml({ heading: title, body: '' }, 0, 1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; }
    .deck { min-height: 100vh; display: flex; align-items: stretch; justify-content: center; }
    .slide { display: none; width: min(1100px, 100%); margin: 0 auto; padding: 3rem 2rem 4rem; min-height: 100vh; }
    .slide.active { display: flex; flex-direction: column; }
    .slide-inner { flex: 1; }
    h1,h2 { margin: 0 0 1rem; line-height: 1.2; }
    h2 { font-size: clamp(1.75rem, 4vw, 2.5rem); }
    .body { font-size: clamp(1rem, 2.2vw, 1.25rem); line-height: 1.6; max-width: 55ch; }
    .notes { margin-top: 2rem; padding: 1rem; border-left: 3px solid #38bdf8; color: #cbd5e1; font-size: 0.95rem; }
    footer { opacity: 0.55; font-size: 0.85rem; margin-top: auto; }
    .toolbar { position: fixed; bottom: 1rem; right: 1rem; display: flex; gap: 0.5rem; z-index: 10; }
    button { background: #2563eb; color: white; border: 0; border-radius: 999px; padding: 0.6rem 1rem; cursor: pointer; }
    button.secondary { background: #334155; }
  </style>
</head>
<body data-template-type="${escapeHtml(templateType)}">
  <div class="deck" id="deck">${slides}</div>
  <div class="toolbar">
    <button type="button" class="secondary" id="prev">Prev</button>
    <button type="button" id="next">Next</button>
  </div>
  <script>
    const slides = [...document.querySelectorAll('.slide')];
    let idx = 0;
    function show(i) {
      idx = Math.max(0, Math.min(slides.length - 1, i));
      slides.forEach((s, n) => s.classList.toggle('active', n === idx));
    }
    document.getElementById('prev').onclick = () => show(idx - 1);
    document.getElementById('next').onclick = () => show(idx + 1);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') show(idx + 1);
      if (e.key === 'ArrowLeft') show(idx - 1);
    });
    show(0);
  </script>
</body>
</html>`;
}
