/**
 * The one definition of "these two records are the same lead".
 *
 * Shared by the import's pre-flight check and the Duplicate Leads screen,
 * deliberately: two screens answering this question differently is how a book
 * ends up full of duplicates that an import swore were not there. Anything that
 * needs the rule reads it from here rather than writing its own.
 *
 * The rule is exact, not similar. Nothing here scores partial or percentage
 * matches — records either share a contact point, or they are the same company
 * name in the same city and state, or they are two records.
 */

/** Signals a match can be reported on, in the order they are reported. */
export type MatchSignal = 'Phone' | 'Email' | 'Company Domain' | 'Location';

export interface LeadMatchOptions {
  /** Which of `phone` / `email` to compare. Absent or empty compares both. */
  checkFields?: string[];
  /** Compare phone numbers by their last 10 digits rather than as written. */
  ignorePhoneFormatting?: boolean;
  /** Also compare the company's own domain, taken from email and website. */
  matchCompanyDomain?: boolean;
  /** Also compare business name AND city AND state, all three together. */
  matchLocation?: boolean;
}

/** Anything with contact columns — an import row or a stored lead. */
export interface MatchableRecord {
  phone?: string | null;
  altPhone?: string | null;
  email?: string | null;
  website?: string | null;
  businessName?: string | null;
  city?: string | null;
  state?: string | null;
}

export interface MatchKeys {
  /** Every number the record can be reached on. */
  phone: Set<string>;
  /** Normalised address, or '' when there is none. */
  email: string;
  /** The company's own domains, from its email and its website. */
  domain: Set<string>;
  /** Business name + city + state as one key, or '' when any is missing. */
  location: string;
}

/**
 * Mailbox providers, which say nothing about which company someone works for.
 * Two leads at gmail.com are two strangers, and domain matching without this
 * list would fold every personal address in the book into one enormous group.
 */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'passport.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me', 'tutanota.com', 'zoho.com', 'zohomail.com',
  'gmx.com', 'gmx.net', 'mail.com', 'mail.ru', 'yandex.com', 'yandex.ru', 'inbox.com', 'fastmail.com',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net',
  'charter.net', 'earthlink.net', 'juno.com', 'optonline.net', 'roadrunner.com', 'rr.com',
  'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'daum.net', 'hanmail.net',
  'rediffmail.com', 'sify.com',
]);

/**
 * Gmail-style dots and +tags address one inbox, so john.carter+crm@gmail.com and
 * johncarter@gmail.com are the same person. Applied only to the providers that
 * actually work that way — elsewhere a dot is part of the address.
 */
const DOT_INSENSITIVE = new Set(['gmail.com', 'googlemail.com']);

/** Normalised email address, or '' when the value isn't one. */
export function emailKey(v?: string | null): string {
  const s = (v ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return s;
  let local = s.slice(0, at);
  const domain = s.slice(at + 1);
  local = local.split('+')[0];
  if (DOT_INSENSITIVE.has(domain)) local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : s;
}

/** The domain part of a normalised address, or '' when there isn't one. */
export function emailDomain(v?: string | null): string {
  const s = (v ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at < 1 ? '' : s.slice(at + 1).replace(/\.+$/, '');
}

/**
 * The host a website column points at — `https://www.AcmeTax.com/contact` and
 * `acmetax.com` are the same company. Written by hand rather than with `new URL`
 * because the column holds whatever a spreadsheet had in it, and a value that
 * isn't a URL at all has to come back empty instead of throwing mid-import.
 */
export function websiteDomain(v?: string | null): string {
  let s = (v ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.split('@').pop() ?? '';
  s = s.split(':')[0];
  s = s.replace(/^www\./, '').replace(/\.+$/, '');
  // A host with no dot is a typo or a bare word, not a company domain.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : '';
}

/**
 * The company domains a record claims, from BOTH its email and its website — a
 * lead whose site is acmetax.com and one whose address ends @acmetax.com are the
 * same firm, and comparing each column only against its own would miss it.
 * Mailbox providers are dropped; see PUBLIC_EMAIL_DOMAINS.
 */
export function companyDomains(rec: MatchableRecord): Set<string> {
  const out = new Set<string>();
  for (const d of [emailDomain(rec.email), websiteDomain(rec.website)]) {
    if (d && !PUBLIC_EMAIL_DOMAINS.has(d)) out.add(d);
  }
  return out;
}

/**
 * Every number a record can be reached on.
 *
 * Compared as WRITTEN by default — trimmed, and nothing else. Digits used to be
 * pulled out and cut to the last ten, which made "+1 (305) 555-1234" and
 * "3055551234" one key; an exact compare is the rule now, so those are two
 * numbers. `ignorePhoneFormatting` puts the digits rule back for the files that
 * need it, where the source writes numbers in a different style to the CRM's and
 * an exact compare finds nothing.
 *
 * Alt numbers are read either way: a sheet listing a firm's direct line while
 * the CRM holds its switchboard as the alt number is the same firm, and matching
 * only phone against phone walks straight past it.
 */
export function phoneKeys(rec: MatchableRecord, ignoreFormatting = false): Set<string> {
  const out = new Set<string>();
  for (const v of [rec.phone, rec.altPhone]) {
    if (ignoreFormatting) {
      const d = (v ?? '').replace(/\D/g, '').slice(-10);
      if (d.length >= 7) out.add(d);
    } else {
      const s = (v ?? '').trim();
      if (s) out.add(s);
    }
  }
  return out;
}

/**
 * Text folded to its words: lower-cased, every separator flattened to one space.
 * "St. Louis" and "St Louis" are one city; "ACME  TAX" and "Acme Tax" one name.
 *
 * Nothing is REMOVED. "Inc", "LLC" and "& Sons" stay exactly where they are —
 * dropping legal suffixes would fold Acme Holdings LLC into Acme Holdings Inc,
 * and those are two companies with two sets of books. Letters and digits of any
 * script survive, so an accented name keeps its shape instead of being minced.
 */
export function textKey(v?: string | null): string {
  return (v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * US states by their two-letter code, so a sheet writing "Florida" and a book
 * holding "FL" are one state rather than two.
 *
 * A fixed lookup of one place under two spellings, not a similarity guess —
 * which is the only kind of folding this file does anywhere.
 */
const STATE_CODES = new Map<string, string>(Object.entries({
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy',
  'district of columbia': 'dc', 'washington dc': 'dc', 'puerto rico': 'pr',
}));

/**
 * A state folded to its code where one is known, else just folded text.
 *
 * The two-letter fallback catches a code written with punctuation — "N.Y."
 * folds to "n y", which is the same state as "NY" and nothing else, since no
 * state name survives folding as two letters.
 */
export function stateKey(v?: string | null): string {
  const s = textKey(v);
  const known = STATE_CODES.get(s);
  if (known) return known;
  const flat = s.replace(/ /g, '');
  return flat.length === 2 ? flat : s;
}

/**
 * The same company at the same place: business name AND city AND state, all
 * three equal after folding.
 *
 * Name alone is deliberately NOT a signal and never will be — franchise
 * branches and common trading names are exactly what a name-only rule gets
 * wrong, and this is the answer to that rather than a retreat from it. "Acme
 * Tax, Miami FL" twice is one firm listed twice; "Acme Tax, Miami FL" and "Acme
 * Tax, Austin TX" stay two leads, which is the whole point of carrying the city
 * and the state.
 *
 * Returns '' unless all three are filled in. A record missing its city has no
 * location to compare, and letting blanks match blanks would quietly collapse
 * every incomplete record in the book into one enormous group.
 */
export function locationKey(rec: MatchableRecord): string {
  const name = textKey(rec.businessName);
  const city = textKey(rec.city);
  const state = stateKey(rec.state);
  if (!name || !city || !state) return '';
  return `n:${name}|c:${city}|s:${state}`;
}

/**
 * The longest word of a value, for narrowing a SQL search down to the rows a
 * location match could possibly accept.
 *
 * Safe to narrow by because folding only ever turns separators into spaces: any
 * word it produces still appears verbatim — case aside — inside the stored
 * text, so `contains` on it is a strict SUPERSET of a location match and never
 * a filter that hides one. The longest word is picked because it is the most
 * selective one available; the compare itself still happens in TypeScript.
 */
export function longestWord(v?: string | null): string {
  let best = '';
  for (const w of textKey(v).split(' ')) if (w.length > best.length) best = w;
  return best;
}

/**
 * The identity a remembered duplicate decision is filed under.
 *
 * Built from the record's own contact points, NOT from the lead it matched or
 * the file it came from. The same company re-exported next month arrives as a
 * different file, in a different row, very likely matching a different lead —
 * but "should this company be imported despite already being in the book?" is
 * the same question, and last month's answer is the useful thing to carry.
 *
 * Deliberately independent of the match OPTIONS. A row's identity cannot change
 * because someone ticked "ignore phone formatting" — that setting decides what
 * counts as a match, not who is asking. So the key always uses the strict,
 * as-written phone and the folded email.
 *
 * Location is a FALLBACK, never a component. A record with any contact point
 * keys exactly as it always has — `p:…|e:…`, byte for byte — so every ruling
 * made before location matching existed is still found under the key it was
 * filed under. Only a record with NO phone and NO email, which used to key
 * under '' and be forgotten the moment the review closed, now falls back to its
 * location. That is the one case the location rule can flag and the memory
 * could not hold: a company listed by name and address alone, ruled on every
 * time the file is re-run.
 *
 * The two shapes cannot collide — one begins `p:`, the other `l:` — so a lead
 * that gains a phone number next month simply asks a fresh question rather than
 * inheriting the answer given to its address, which is the honest outcome: it
 * is a different record from the one that was ruled on.
 *
 * Returns '' for a record with neither a contact point nor a complete location,
 * which cannot be recognised again and therefore must not be remembered.
 */
export function decisionKey(rec: MatchableRecord): string {
  const phones = [...phoneKeys(rec, false)].sort();
  const email = emailKey(rec.email);
  if (phones.length === 0 && !email) return locationKey(rec) ? `l:${locationKey(rec)}` : '';
  return `p:${phones.join('+')}|e:${email}`;
}

/** Every key a record matches on, under one set of options. */
export function buildMatchKeys(rec: MatchableRecord, opts: LeadMatchOptions = {}): MatchKeys {
  const checkAll = !opts.checkFields || opts.checkFields.length === 0;
  const wantPhone = checkAll || opts.checkFields!.includes('phone');
  const wantEmail = checkAll || opts.checkFields!.includes('email');
  return {
    phone: wantPhone ? phoneKeys(rec, opts.ignorePhoneFormatting) : new Set<string>(),
    email: wantEmail ? emailKey(rec.email) : '',
    domain: opts.matchCompanyDomain ? companyDomains(rec) : new Set<string>(),
    location: opts.matchLocation ? locationKey(rec) : '',
  };
}
