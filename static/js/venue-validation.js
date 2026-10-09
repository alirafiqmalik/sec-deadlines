export const MAX_BYTES = 6000;
export const DAILY_LIMIT = 5;
export const TOPICS = ["SEC", "CRYPTO", "PQC", "QUANTUM", "FORMAL", "AI"];
export const KINDS = ["CONF", "WORKSHOP", "TUTORIAL", "POSTER", "TOOLS"];
export const RANKS = ["TOP4", "CORE-A", "CORE-B", "CORE-C", "OTHERS"];
const fields = ["name", "year", "description", "link", "dblp", "deadline", "timezone", "date", "place", "comment", "tags"];
const required = ["name", "year", "link", "deadline", "timezone", "date", "place", "tags"];

export class InvalidSubmission extends Error {}

function plainText(value, field, max) {
  if (typeof value !== "string" || !value.length || value.length > max || value !== value.trim() || /[\p{C}<>\u2028\u2029]|\{\{|\{%|\}\}|%\}/u.test(value)) {
    throw new InvalidSubmission(`${field}: enter plain text within the field limit. HTML and control characters are not allowed.`);
  }
  return value;
}

export function publicUrl(value, field) {
  plainText(value, field, 400);
  let decoded = value;
  try {
    for (let i = 0; i < 3; i++) {
      decoded = decodeURIComponent(decoded);
      plainText(decoded, field, 400);
    }
  } catch {
    throw new InvalidSubmission(`${field}: enter a valid HTTPS URL.`);
  }
  if (/[\s"'\\`]/u.test(decoded)) throw new InvalidSubmission(`${field}: enter a plain HTTPS URL.`);
  let url;
  try { url = new URL(value); } catch { throw new InvalidSubmission(`${field}: enter a valid HTTPS URL.`); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
      /\.(localhost|local|internal|test|invalid|example|onion)$/.test(host)) {
    throw new InvalidSubmission(`${field}: use HTTPS and a public domain without credentials or a custom port.`);
  }
  return value;
}

export function validatePayload(payload, year = new Date().getUTCFullYear()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).sort().join() !== "schemaVersion,source,venue" || payload.schemaVersion !== 1) {
    throw new InvalidSubmission("Unsupported submission format.");
  }
  const venue = payload.venue;
  if (!venue || typeof venue !== "object" || Array.isArray(venue) || Object.keys(venue).some(f => !fields.includes(f)) || required.some(f => !(f in venue))) {
    throw new InvalidSubmission("Venue fields are missing or unsupported.");
  }
  plainText(venue.name, "name", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9 &().+:/-]*$/.test(venue.name)) throw new InvalidSubmission("name: use letters, digits, spaces, or & ( ) . + : / -.");
  if (!Number.isInteger(venue.year) || venue.year < year || venue.year > year + 5) throw new InvalidSubmission("year: use the current year or one of the next five years.");
  for (const [field, max] of [["description", 240], ["date", 100], ["place", 120], ["comment", 600]]) {
    if (field in venue) plainText(venue[field], field, max);
  }
  publicUrl(venue.link, "link");
  publicUrl(payload.source, "source");
  if (venue.dblp) {
    publicUrl(venue.dblp, "dblp");
    if (new URL(venue.dblp).hostname !== "dblp.org") throw new InvalidSubmission("dblp: use a URL on dblp.org.");
  } else if ("dblp" in venue) throw new InvalidSubmission("dblp: omit an empty optional field.");
  plainText(venue.timezone, "timezone", 64);
  if (!/^[A-Za-z0-9_+/-]+$/.test(venue.timezone) || venue.timezone.includes("..")) throw new InvalidSubmission("timezone: enter an IANA timezone.");
  try { new Intl.DateTimeFormat("en", { timeZone: venue.timezone }); } catch { throw new InvalidSubmission("timezone: enter a recognized IANA timezone."); }
  if (!Array.isArray(venue.deadline) || !venue.deadline.length || venue.deadline.length > 8 || new Set(venue.deadline).size !== venue.deadline.length) throw new InvalidSubmission("deadline: enter one to eight unique dates, or TBA alone.");
  for (const deadline of venue.deadline) {
    if (deadline === "TBA" && venue.deadline.length === 1) continue;
    if (typeof deadline !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(deadline)) throw new InvalidSubmission("deadline: use YYYY-MM-DD HH:mm, or TBA alone.");
    const date = new Date(`${deadline.replace(" ", "T")}:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 16).replace("T", " ") !== deadline || date.getUTCFullYear() < venue.year - 2 || date.getUTCFullYear() > venue.year) throw new InvalidSubmission("deadline: enter a real date within two years before the venue year.");
  }
  const tags = venue.tags;
  if (!Array.isArray(tags) || tags.length < 2 || tags.length > 12 || new Set(tags).size !== tags.length || tags.some(t => ![...TOPICS, ...KINDS, ...RANKS].includes(t)) || !tags.some(t => TOPICS.includes(t)) || !tags.some(t => KINDS.includes(t)) || tags.filter(t => RANKS.includes(t)).length > 1) {
    throw new InvalidSubmission("tags: select a research domain, publication type, and at most one ranking.");
  }
  // Fix field order before hashing/signing, independent of client JSON order.
  const canonical = Object.fromEntries(fields.filter(f => f in venue).map(f => [f, venue[f]]));
  canonical.tags = [...venue.tags].sort();
  return { schemaVersion: 1, venue: canonical, source: payload.source };
}

export function venueKey(venue) {
  return `${venue.name.toLowerCase().replace(/[^a-z0-9]/g, "")}:${venue.year}`;
}
