/**
 * Canonical semantic capability grammar for external tools.
 *
 * Practical, extensible, not a giant taxonomy:
 *   <domain>.<resource>.<verb>
 *
 * Examples:
 *   communication.email.read
 *   communication.email.search
 *   communication.email.send
 *   documents.read
 *   calendar.write
 *   source_control.read
 *
 * Classification DESCRIBES a tool. It does not grant Task authority.
 * Task.capabilities remain independently authoritative.
 */

export const CAPABILITY_DOMAINS = Object.freeze([
  'communication',
  'documents',
  'calendar',
  'projects',
  'source_control',
  'crm',
  'knowledge',
  'permissions',
  'generic',
]);

export const CAPABILITY_VERBS = Object.freeze([
  'read',
  'search',
  'write',
  'send',
  'create',
  'update',
  'delete',
]);

export const CONSEQUENCE = Object.freeze({
  READ: 'READ',
  WRITE: 'WRITE',
  CONSEQUENTIAL: 'CONSEQUENTIAL',
  DESTRUCTIVE: 'DESTRUCTIVE',
  SENSITIVE: 'SENSITIVE',
});

const CAP_RE = /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?(?:\.([a-z][a-z0-9_]*))?$/;

export function parseCapability(raw) {
  const text = String(raw || '').trim().toLowerCase();
  const match = text.match(CAP_RE);
  if (!match) return null;
  const [, a, b, c] = match;
  if (c) return { domain: a, resource: b, verb: c, id: `${a}.${b}.${c}` };
  if (b && CAPABILITY_VERBS.includes(b)) {
    return { domain: a, resource: null, verb: b, id: `${a}.${b}` };
  }
  if (b) return { domain: a, resource: b, verb: 'read', id: `${a}.${b}.read` };
  return { domain: a, resource: null, verb: 'read', id: `${a}.read` };
}

export function capabilityId(parsed) {
  if (!parsed) return null;
  return parsed.id;
}

export function isWriteVerb(verb) {
  return ['write', 'send', 'create', 'update', 'delete'].includes(String(verb || ''));
}

export function consequenceForVerb(verb, { destructive = false, sensitive = false } = {}) {
  if (destructive || verb === 'delete') return CONSEQUENCE.DESTRUCTIVE;
  if (sensitive) return CONSEQUENCE.SENSITIVE;
  if (verb === 'send') return CONSEQUENCE.CONSEQUENTIAL;
  if (isWriteVerb(verb)) return CONSEQUENCE.WRITE;
  return CONSEQUENCE.READ;
}

export function capabilitySatisfies(held, needed) {
  const have = parseCapability(held);
  const need = parseCapability(needed);
  if (!have || !need) return false;
  if (have.domain !== need.domain) return false;
  if (need.resource && have.resource && have.resource !== need.resource) return false;
  if (need.verb === 'read' || need.verb === 'search') {
    return have.verb === need.verb || have.verb === 'read' || have.verb === 'search';
  }
  // "write" is the generic mutation family: a task needing calendar.write is
  // satisfied by a create or update tool, and a generic write tool covers a
  // create/update need. send and delete stay exact - they carry their own
  // consequence semantics and are never implied.
  if (need.verb === 'write') {
    return ['write', 'create', 'update'].includes(have.verb);
  }
  if (need.verb === 'create' || need.verb === 'update') {
    return have.verb === need.verb || have.verb === 'write';
  }
  return have.verb === need.verb;
}

export function taskHoldsCapability(taskCapabilities, needed) {
  const list = Array.isArray(taskCapabilities) ? taskCapabilities : [];
  return list.some((held) => capabilitySatisfies(held, needed));
}

export function taskHoldsAnyExternalCapability(taskCapabilities) {
  const list = Array.isArray(taskCapabilities) ? taskCapabilities : [];
  return list.some((cap) => {
    const parsed = parseCapability(cap);
    return parsed && CAPABILITY_DOMAINS.includes(parsed.domain);
  });
}

export function writeRequiresExplicitConnection(consequence) {
  return (
    consequence === CONSEQUENCE.WRITE ||
    consequence === CONSEQUENCE.CONSEQUENTIAL ||
    consequence === CONSEQUENCE.DESTRUCTIVE ||
    consequence === CONSEQUENCE.SENSITIVE
  );
}
