/**
 * Reading the home feed's header line.
 *
 * Unfollow everybody and the feed does not empty — it refills. Verified on a
 * real account with the Following list at zero: every post left was there
 * because somebody in the network liked, commented on or reposted it, or
 * because LinkedIn suggested it, or because it was an ad. Each of those arrives
 * with a HEADER line above the author saying why you are being shown it:
 *
 *     Feed post                 ← screen-reader prefix, sometimes absent
 *     Priya Raman likes this    ← the header
 *     Marcus Webb               ← the author block starts here
 *     • 2nd
 *     Head of Data at Northwind
 *     3h •
 *     …the post…
 *
 * A post from somebody you actually follow has no header: it starts at the
 * author block. That is the whole distinction, and it is the only one worth
 * making, because the markup around it has no stable class names — LinkedIn
 * obfuscates them and ships `[componentkey]` attributes instead.
 *
 * So this module is deliberately small and deliberately timid:
 *
 *   1. **An item is only a post if it has an author block** — a degree marker
 *      (`• 1st`, `• 2nd`, `• 3rd`, `• 3rd+`) or `• Following`. No author block,
 *      no classification: `unknown`, and `unknown` is never hidden. That is
 *      what keeps the composer, the "Start a post" card, the draft box and
 *      every other list item in the page untouched.
 *   2. **Only the lines *above* the author block can be the header.** Anything
 *      from the author's name down — headline, body, "Promoted" quoted in a
 *      sentence, "3 comments" under the post — is out of reach by construction.
 *   3. **An unrecognised header is not a category.** It falls through to
 *      `direct`, which is shown. Being wrong in that direction costs you a post
 *      you have to scroll past; being wrong the other way hides something you
 *      wanted, silently, and you never find out.
 *
 * Pure: no DOM, no `chrome`, no network. Everything here takes a string.
 */

import { QUIET_CATEGORY } from '../constants.js';

/**
 * How many lines above the author block are looked at for a header.
 *
 * The header is the first of them in practice. Two, because the screen-reader
 * prefix is not always the exact string we strip, and one line of slack costs
 * nothing when every pattern has to match a whole line anyway.
 */
export const HEADER_LOOKBACK = 2;

/**
 * The author block: a connection degree, or `Following` for a page.
 *
 * `•` is what LinkedIn uses; `·` is accepted because the two are trivially
 * confused and the degree word after it is what actually decides.
 */
const AUTHOR_BLOCK_RE = /[•·]\s*(?:1st|2nd|3rd\+?|Following)\b/i;

/** The screen-reader prefix, when it is there. Stripped before anything else. */
const FEED_POST_PREFIX_RE = /^feed post(?:\s+number\s+\d+)?$/i;

/**
 * Things that are emphatically not posts, recognised by their own first line.
 *
 * The author-block rule already excludes all of these — none of them carries a
 * degree marker — but they are the exact things a bug in this file would hide,
 * so they are named out loud and checked first.
 */
const NON_POST_RE = /^(?:start a post|draft\b|create a post|share a post|add a post)/i;

/**
 * `<somebody>`, optionally with the "and 3 others" that LinkedIn adds when a
 * post reaches several people you know.
 *
 * Non-greedy, and every pattern below anchors both ends, so this can only ever
 * eat a whole header line — never part of a name and part of a verb.
 */
const WHO = '.+?(?:\\s+and\\s+[\\d,]+\\s+others?)?';

/** `<Who> likes this` · `celebrates` · `loves` · `supports` · `finds this insightful`. */
const REACTION_RE = new RegExp(
  `^${WHO}\\s+(?:likes?|celebrates?|loves?|supports?|finds?|find)\\s+this(?:\\s+(?:insightful|funny|helpful))?$`,
  'i',
);

/** `<Who> commented` · `<Who> commented on this` · `<Who> replied to this`. */
const COMMENT_RE = new RegExp(
  `^${WHO}\\s+(?:commented|replied)(?:\\s+on\\s+this|\\s+to\\s+this)?$`,
  'i',
);

/** `<Who> reposted this`. */
const REPOST_RE = new RegExp(`^${WHO}\\s+reposted(?:\\s+this)?$`, 'i');

/** `Followed by <Name>` — a person one of your connections follows. */
const FOLLOWED_BY_RE = /^followed by\s+.+$/i;

/** LinkedIn's own recommendation. Its own word, on its own line. */
const SUGGESTED_RE = /^suggested(?:\s+(?:post|for you))?$/i;

/** An ad. Its own word, on its own line — "Promoted" inside a post is body text. */
const PROMOTED_RE = /^promoted$/i;

/**
 * The rest of the "somebody you know did something" headers, named one by one.
 *
 * A closed list on purpose. A general rule here — "any header we do not
 * otherwise recognise" — would hide posts nobody asked it to hide the first
 * time LinkedIn invents a phrase, which is the one failure this file is built
 * to avoid.
 */
const OTHER_ACTIVITY_RES = [
  new RegExp(`^${WHO}\\s+(?:was\\s+)?mentioned(?:\\s+.*)?$`, 'i'),
  new RegExp(`^${WHO}\\s+is\\s+hiring\\b.*$`, 'i'),
  new RegExp(`^${WHO}\\s+posted\\s+a\\s+job\\b.*$`, 'i'),
  new RegExp(`^${WHO}\\s+shared\\s+this$`, 'i'),
  new RegExp(`^${WHO}\\s+(?:is\\s+)?attending\\b.*$`, 'i'),
  new RegExp(`^${WHO}\\s+(?:started|starts)\\s+following\\b.*$`, 'i'),
  new RegExp(`^${WHO}\\s+(?:follows|is\\s+following)\\s+.+$`, 'i'),
];

/** Header pattern → category, in the order they are tried. */
const HEADER_RULES = [
  [PROMOTED_RE, QUIET_CATEGORY.PROMOTED],
  [SUGGESTED_RE, QUIET_CATEGORY.SUGGESTED],
  [FOLLOWED_BY_RE, QUIET_CATEGORY.FOLLOWED_BY],
  [REPOST_RE, QUIET_CATEGORY.REPOST],
  [COMMENT_RE, QUIET_CATEGORY.COMMENT],
  [REACTION_RE, QUIET_CATEGORY.REACTION],
  ...OTHER_ACTIVITY_RES.map((re) => [re, QUIET_CATEGORY.OTHER_ACTIVITY]),
];

/* ================================================================== */
/*  Lines                                                             */
/* ================================================================== */

/**
 * A post's `innerText`, as trimmed non-empty lines with the screen-reader
 * prefix dropped.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function lines(text) {
  const all = String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return all.length && FEED_POST_PREFIX_RE.test(all[0]) ? all.slice(1) : all;
}

/**
 * Where the author block starts, or `-1` if there is no author block and this
 * therefore is not a post.
 *
 * @param {string[]} rows
 * @returns {number}
 */
export function authorBlockIndex(rows) {
  return rows.findIndex((line) => AUTHOR_BLOCK_RE.test(line));
}

/**
 * Split an item into "lines that could be a header" and "the author block and
 * everything under it".
 *
 * The degree marker turns up in two shapes depending on how the name and the
 * distance are laid out, and the difference decides how many lines above it
 * belong to the author rather than to a header:
 *
 *     Priya Raman likes this      Priya Raman likes this
 *     Marcus Webb            vs   Marcus Webb • 2nd
 *     • 2nd                       Head of Data at Northwind
 *
 * On the left the name is its own line, so the header can only be what sits
 * *above* the name. On the right the marker line already contains the name, so
 * everything above it is fair game. Getting this wrong in the timid direction
 * costs a post shown; getting it wrong the other way hides one.
 *
 * @param {string} text
 * @returns {{rows: string[], author: number, headerEnd: number}} `headerEnd` is
 *   an exclusive upper bound: rows below it can never be a header.
 */
function read(text) {
  const rows = lines(text);
  const author = authorBlockIndex(rows);
  if (author === -1) return { rows, author, headerEnd: 0 };
  const nameIsOwnLine = /^[•·]/.test(rows[author]);
  return { rows, author, headerEnd: Math.max(0, nameIsOwnLine ? author - 1 : author) };
}

/**
 * The header line of a post, or `null`.
 *
 * `null` means one of four things, and the caller does not need to tell them
 * apart because all four end in "leave it alone": it is not a post at all; it
 * is a post from somebody you follow, so there is nothing above the author; the
 * line above the author is the author's own name repeated; or that line is a
 * header no rule here recognises.
 *
 * @param {string} text a post container's `innerText`
 * @returns {string|null}
 */
export function extractHeader(text) {
  const { rows, headerEnd } = read(text);
  if (!rows.length || headerEnd < 1) return null;
  if (NON_POST_RE.test(rows[0])) return null;

  const limit = Math.min(headerEnd, HEADER_LOOKBACK);
  for (let i = 0; i < limit; i += 1) {
    // LinkedIn prints the author's name twice — once for the photo link, once
    // in the byline. A line repeated immediately below itself is a name.
    if (rows[i] === rows[i + 1]) break;
    for (const [pattern] of HEADER_RULES) {
      if (pattern.test(rows[i])) return rows[i];
    }
  }
  return null;
}

/**
 * What a feed item is.
 *
 * @param {string} text a post container's `innerText`
 * @returns {string} one of `QUIET_CATEGORY`
 */
export function classifyPost(text) {
  const { rows, author } = read(text);
  if (!rows.length) return QUIET_CATEGORY.UNKNOWN;
  if (NON_POST_RE.test(rows[0])) return QUIET_CATEGORY.UNKNOWN;
  if (author === -1) return QUIET_CATEGORY.UNKNOWN;

  const header = extractHeader(text);
  if (header === null) return QUIET_CATEGORY.DIRECT;

  for (const [pattern, category] of HEADER_RULES) {
    if (pattern.test(header)) return category;
  }
  /* Unreachable: `extractHeader` only returns lines a rule matched. Shown, if
     it ever happens, because that is the safe way to be wrong. */
  return QUIET_CATEGORY.DIRECT;
}
