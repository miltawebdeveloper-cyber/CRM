/**
 * The one definition of "these two records are the same lead".
 *
 * Shared by the import's pre-flight check and the Duplicate Leads screen,
 * deliberately: two screens answering this question differently is how a book
 * ends up full of duplicates that an import swore were not there. Anything that
 * needs the rule reads it from here rather than writing its own.
 *
 * The rule is exact, not similar. Nothing here scores partial or percentage
 * matches — records either share a contact point or they are two records.
 */

/** Signals a match can be reported on, in the order they are reported. */
export type MatchSignal = 'Phone' | 'Email' | 'Company Domain';

export interface LeadMatchOptions {
  /** Which of `phone` / `email` to compare. Absent or empty compares both. */
  checkFields?: string[];
  /** Compare phone numbers by their last 10 digits rather than as written. */
  ignorePhoneFormatting?: boolean;
  /** Also compare the company's own domain, taken from email and website. */
  matchCompanyDomain?: boolean;
}

/** Anything with contact columns — an import row or a stored lead. */
export interface MatchableRecord {
  phone?: string | null;
  altPhone?: string | null;
  email?: string | null;
  website?: string | null;
}

export interface MatchKeys {
  /** Every number the record can be reached on. */
  phone: Set<string>;
  /** Normalised address, or '' when there is none. */
  email: string;
  /** The company's own domains, from its email and its website. */
  domain: Set<string>;
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
 * Returns '' for a record with no contact point at all, which cannot be
 * recognised again and therefore must not be remembered.
 */
export function decisionKey(rec: MatchableRecord): string {
  const phones = [...phoneKeys(rec, false)].sort();
  const email = emailKey(rec.email);
  if (phones.length === 0 && !email) return '';
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
  };
}
