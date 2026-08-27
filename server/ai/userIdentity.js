// Display-name picker shared by Memory, voice briefing, and project invite.
export function pickUserDisplayName(user) {
  const meta = (user && user.user_metadata) || {};
  const candidates = [
    meta.preferred_name,
    meta.first_name,
    meta.given_name,
    meta.full_name,
    meta.name,
    meta.user_name,
    meta.username,
  ];
  for (const raw of candidates) {
    const v = String(raw || '').trim();
    if (!v) continue;
    const first = v.split(/\s+/)[0].trim();
    if (first) return first;
  }
  const email = String(user?.email || '').trim();
  if (email && email.includes('@')) {
    const handle = email.split('@')[0]
      .replace(/[._-]+/g, ' ')
      .trim()
      .split(/\s+/)[0];
    if (handle) {
      // Capitalise the first letter so the greeting reads naturally.
      return handle.charAt(0).toUpperCase() + handle.slice(1);
    }
  }
  return '';
}
