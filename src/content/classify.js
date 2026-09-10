/**
 * Reading a feed post's opening lines.
 *
 * Unfollow everybody and the feed does not empty — it refills. Verified on a
 * real account with the Following list at zero, and then verified again against
 * the live page: what is left arrives with something in its first few lines
 * saying why you are being shown it.
 *
 * There are four of those signals, and they are not all headers:
 *
 *     Feed post                     Feed post                 Feed post
 *     Priya Raman likes this        The Agency Blueprint      Aly M
 *     Marcus Webb                   10,927 followers          • 3rd+
 *     • 2nd                         Promoted                  Founder & CEO
 *     Head of Data                  If I lost my agency…      1d • Edited •
 *     3h •                                                    Follow
 *     …the post…                                              …the post…
 *
 *   1. **A header above the author** — "Priya likes this", "Priya and 3 others
 *      commented", "Priya reposted this", "Followed by Priya", "Suggested".
 *   2. **A line that is exactly "Promoted"**, which for a page sits *below* the
 *      name rather than above it, so it is not a header at all.
 *   3. **A standalone "Follow" button line.** LinkedIn only draws it when you do
 *      not already follow the author, which makes it an unlabelled suggestion —
 *      the biggest category on an emptied feed, and the one with no header.
 *   4. **Nothing** — a post from somebody you actually follow.
 *
 * The markup around all of that has no stable class names; LinkedIn obfuscates
 * them on every build and ships `[componentkey]` attributes instead. So this
 * reads the rendered text, and it is deliberately timid about it:
 *
 *   - **An item is only a post if it has an author block** — a degree marker
 *     (`• 1st`, `• 2nd`, `• 3rd+`, `• Following`), a follower count on its own
 *     line, or the post's own age (`1w • Edited •`). No author block, no
 *     classification: `unknown`, and `unknown` is never hidden. That is what
 *     keeps the composer, the draft box, the "Start a post" card, "Add to your
 *     feed" and the sort control untouched.
 *   - **Only lines above the author block can be a header**, and only the first
 *     few lines of an item can hold a Follow button or a "Promoted". A post's
 *     body is out of reach by construction, so "Promoted" quoted in a sentence
 *     and "3 comments" under a post cannot be read as either.
 *   - **An unrecognised header is not a category.** It falls through to
 *     `direct`, which is shown. Being wrong in that direction costs a post you
 *     scroll past; being wrong the other way hides one, silently.
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

/** Lines from the top of an item that can hold a bare "Promoted". */
export const PROMOTED_LOOKAHEAD = 6;

/** Lines from the top of an item that can hold the Follow button. */
export const FOLLOW_LOOKAHEAD = 7;

/* ================================================================== */
/*  The author block                                                  */
/* ================================================================== */

/** A person: the connection degree, or `Following` on a page you follow. */
const DEGREE_RE = /[•·]\s*(?:1st|2nd|3rd\+?|Following)\b/i;

/**
 * A page: its follower count, on a line of its own.
 *
 * Company and newsletter posts carry no degree marker at all — this is their
 * author block, and without it every promoted page post reads as "not a post".
 * Anchored at both ends so "Software · 1,234 followers" in a sidebar module is
 * not mistaken for one.
 */
const FOLLOWERS_RE = /^\d[\d,.]*\s*[KMkm]?\s+followers$/;

/**
 * The post's own age, which every post has and nothing else does.
 *
 * `1d •`, `3h •`, `1w • Edited •`. The bullet immediately after the age is what
 * makes this safe to look for: it is the separator LinkedIn puts between the
 * age and the visibility icon, not something a sentence produces.
 */
const AGE_RE = /^\d+\s*(?:s|m|h|d|w|mo|y|hr|hrs|min|mins)\b\s*[•·]/i;

/** Any of the three. One of these lines, and the item is a post. */
const isAuthorBlock = (line) =>
  DEGREE_RE.test(line) || FOLLOWERS_RE.test(line) || AGE_RE.test(line);

/**
 * True when the author-block line holds no name, so the name is the line above.
 *
 * `Marcus Webb • 2nd` carries its own name and everything above it is fair
 * game; a bare `• 2nd`, `10,927 followers` or `1w • Edited •` does not, and the
 * line above it is the author's name rather than a header.
 */
const isMarkerOnly = (line) =>
  /^[•·]/.test(line) || FOLLOWERS_RE.test(line) || AGE_RE.test(line);

/* ================================================================== */
/*  The other three signals                                           */
/* ================================================================== */

/** The screen-reader prefix, when it is there. Stripped before anything else. */
const FEED_POST_PREFIX_RE = /^feed post(?:\s+number\s+\d+)?$/i;

/**
 * Things that are emphatically not posts, recognised by their own first line.
 *
 * The author-block rule already excludes all of these — none of them carries an
 * author block — but they are the exact things a bug in this file would hide,
 * so they are named out loud and checked first.
 */
const NON_POST_RE = /^(?:start a post|draft\b|create a post|share a post|add a post)/i;

/** An ad. A whole line, on its own — "Promoted" inside a post is body text. */
const PROMOTED_RE = /^promoted$/i;

/**
 * The Follow button, as a line of its own.
 *
 * Only ever drawn for an author you do not follow. A `Following` line, or no
 * button at all, means you do follow them — so only the bare word counts, and
 * `Follow` inside a longer line ("Follow us on…", "Follow-up") does not.
 */
const FOLLOW_BUTTON_RE = /^\+?\s*follow$/i;

/* ================================================================== */
/*  Headers                                                           */
/* ================================================================== */

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

/** `<Who> follows this page` — the same statement about a company. */
const FOLLOWS_PAGE_RE = new RegExp(`^${WHO}\\s+follows\\s+this\\s+page$`, 'i');

/** LinkedIn's own recommendation. Its own word, on its own line. */
const SUGGESTED_RE = /^suggested(?:\s+(?:post|for you))?$/i;

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
  [FOLLOWS_PAGE_RE, QUIET_CATEGORY.FOLLOWED_BY],
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
 * Where the author block starts, or `-1` if there is none and this therefore is
 * not a post.
 *
 * @param {string[]} rows
 * @returns {number}
 */
export function authorBlockIndex(rows) {
  return rows.findIndex(isAuthorBlock);
}

/**
 * Split an item into "lines that could be a header" and the rest.
 *
 * `headerEnd` is an exclusive upper bound. It is one line short of the author
 * block whenever that block is a bare marker, because the line immediately
 * above a bare marker is the author's own name:
 *
 *     Priya Raman likes this        The Agency Blueprint      Marcus Webb • 2nd
 *     Marcus Webb                   10,927 followers          Head of Data
 *     • 2nd                         Promoted
 *
 * On the left and in the middle the name is its own line, so only what is above
 * the name can be a header — which is what keeps a page called "Everyone Loves
 * This" from reading as somebody's reaction. On the right the marker line
 * already carries the name, so everything above it is fair game.
 *
 * @param {string} text
 * @returns {{rows: string[], author: number, headerEnd: number}}
 */
function read(text) {
  const rows = lines(text);
  const author = authorBlockIndex(rows);
  if (author === -1) return { rows, author, headerEnd: 0 };
  return {
    rows,
    author,
    headerEnd: Math.max(0, isMarkerOnly(rows[author]) ? author - 1 : author),
  };
}

/** Is there a bare "Promoted" up where the author block is, rather than in the post? */
function isPromoted(rows, author) {
  const limit = Math.min(rows.length, PROMOTED_LOOKAHEAD, author + 3);
  for (let i = 0; i < limit; i += 1) if (PROMOTED_RE.test(rows[i])) return true;
  return false;
}

/** Is there a Follow button up where the author block is — i.e. you do not follow them? */
function hasFollowButton(rows, author) {
  const limit = Math.min(rows.length, FOLLOW_LOOKAHEAD, author + 5);
  for (let i = 0; i < limit; i += 1) if (FOLLOW_BUTTON_RE.test(rows[i])) return true;
  return false;
}

/**
 * The header line of a post, or `null`.
 *
 * `null` means one of four things, and the caller does not need to tell them
 * apart because all four end in "do not hide it for this reason": it is not a
 * post at all; it is a post with nothing above the author; the line above the
 * author is the author's own name repeated; or that line is a header no rule
 * here recognises.
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
 * The order is the precedence, and it was decided by what a reader would want
 * told first: an ad is an ad however it reached you, a header says who put this
 * in front of you, and a Follow button is only consulted when nothing else
 * explained the post.
 *
 * @param {string} text a post container's `innerText`
 * @returns {string} one of `QUIET_CATEGORY`
 */
export function classifyPost(text) {
  const { rows, author } = read(text);
  if (!rows.length) return QUIET_CATEGORY.UNKNOWN;
  if (NON_POST_RE.test(rows[0])) return QUIET_CATEGORY.UNKNOWN;
  if (author === -1) return QUIET_CATEGORY.UNKNOWN;

  if (isPromoted(rows, author)) return QUIET_CATEGORY.PROMOTED;

  const header = extractHeader(text);
  if (header !== null) {
    for (const [pattern, category] of HEADER_RULES) {
      if (pattern.test(header)) return category;
    }
  }

  if (hasFollowButton(rows, author)) return QUIET_CATEGORY.NOT_FOLLOWED;

  return QUIET_CATEGORY.DIRECT;
}
