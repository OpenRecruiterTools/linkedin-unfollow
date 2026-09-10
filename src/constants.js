/**
 * The handful of numbers and names both halves of the extension agree on.
 *
 * The popup draws its limit box from these; the service worker enforces them.
 * They live in their own module so importing them into the popup does not drag
 * the service worker's message listener into the popup page with them.
 */

/** Message types the service worker answers, plus the one it sends. */
export const MESSAGES = Object.freeze({
  COUNT: 'count',
  PREVIEW: 'preview',
  UNFOLLOW: 'unfollow',
  /** Popup → worker, mid-run. Answered immediately; the run winds itself down. */
  STOP: 'stop',
  /** Worker → popup, every ten. Not a request. */
  PROGRESS: 'progress',
  /** Quiet feed content script → popup, when the count changes. Not a request. */
  QUIET_FEED_HIDDEN: 'quietFeedHidden',
});

/**
 * Which list a run works through.
 *
 * `following` is LinkedIn's own "Following" list, and it is the default because
 * it is what every earlier version did. `everyone` adds a second pass over your
 * *followers*, because connections are followed automatically when you connect
 * and never appear on the Following list — see `linkedin.js`.
 */
export const SCOPE = Object.freeze({
  FOLLOWING: 'following',
  EVERYONE: 'everyone',
});

/**
 * How hard a run pushes.
 *
 * `careful` is one request at a time with a 0.8–1.6 s gap — the default, and
 * the one to use. `fast` runs three streams over the same list at 0.5–0.9 s
 * each, so about four unfollows a second: several times quicker, and several
 * times more likely to be the thing LinkedIn rate-limits.
 */
export const SPEED = Object.freeze({
  CAREFUL: 'careful',
  FAST: 'fast',
});

/** How many streams `fast` runs. Three, and not a knob. */
export const FAST_STREAMS = 3;

/** The one phase a progress message ever names: the followers scan. */
export const PHASE = Object.freeze({
  SCANNING: 'scanning',
});

/** You can ask for one. That is the run you should try first. */
export const UNFOLLOW_LIMIT_MIN = 1;

/** A ceiling, not a target: one run does not get to be unbounded. */
export const UNFOLLOW_LIMIT_MAX = 5000;

/** What the box is filled in with, so a first run is small. */
export const UNFOLLOW_LIMIT_DEFAULT = 25;

/** How many names "Check count" and "Preview" show. */
export const UNFOLLOW_SAMPLE_MAX = 10;

/**
 * One unfollow every 0.8–1.6 seconds, randomised.
 *
 * This is a request the site's own page makes, one at a time, in the order a
 * person would make them. The randomised gap is what keeps it from looking
 * like a script; removing it is how accounts get restricted.
 */
export const PACING = Object.freeze({
  minDelayMs: 800,
  maxDelayMs: 1600,
});

/**
 * One request every 0.5–0.9 seconds *per stream*, in `fast`.
 *
 * Three streams at this gap is roughly four unfollows a second. It is still
 * randomised and still gapped; it is simply far less patient, which is why the
 * popup makes you tick a box that says so.
 */
export const FAST_PACING = Object.freeze({
  minDelayMs: 500,
  maxDelayMs: 900,
});

/**
 * One followers page every 0.4–0.8 seconds, randomised.
 *
 * Reading is cheaper than writing and the followers list is long — 9,479
 * followers is 190 pages — so the gap between reads is half the gap between
 * unfollows. It is still a gap: the scan never bursts.
 */
export const SCAN_PACING = Object.freeze({
  minDelayMs: 400,
  maxDelayMs: 800,
});

/** Progress is announced this often, so a long run does not go quiet. */
export const PROGRESS_EVERY = 10;

/** How the run was ended. */
export const STOPPED = Object.freeze({
  LIMIT: 'limit',
  END: 'end',
  STOPPED: 'stopped',
  ERROR: 'error',
});

/* ================================================================== */
/*  Quiet feed                                                        */
/* ================================================================== */

/**
 * What a post in the home feed turned out to be.
 *
 * Unfollowing empties the list of people whose posts you subscribed to. It does
 * not empty the feed: LinkedIn refills it with what your network *did* — liked,
 * commented on, reposted — plus suggestions and ads. Those arrive with a header
 * line above the author that says why you are being shown them, and that header
 * is the only stable thing about them: the markup has no class names worth
 * matching on. See `src/content/classify.js`.
 *
 * `direct` is a post from somebody you actually follow — no header at all — and
 * `unknown` is anything we could not read confidently, including the composer
 * and the "Start a post" card. Neither is ever hidden.
 */
export const QUIET_CATEGORY = Object.freeze({
  PROMOTED: 'promoted',
  SUGGESTED: 'suggested',
  REACTION: 'reaction',
  COMMENT: 'comment',
  REPOST: 'repost',
  FOLLOWED_BY: 'followed-by',
  OTHER_ACTIVITY: 'other-activity',
  /**
   * A post carrying a Follow button — an unlabelled suggestion.
   *
   * LinkedIn only draws that button when you do not already follow the author,
   * so its presence is the same statement "Suggested" makes, without the word.
   * It is the largest category on a feed you have just emptied, and it is the
   * one that has no header at all.
   */
  NOT_FOLLOWED: 'not-followed',
  /**
   * A post in a group you joined.
   *
   * It has no header. What gives it away is the shape of the author block: the
   * group's name on one line, then the author's name and degree together on the
   * next (`MuHAMMAD Tariq • 3rd+`). A plain person's post puts the name on its
   * own line above a bare `• 3rd+`, with nothing above that.
   */
  GROUP: 'group',
  /**
   * A recommendation module, not a post at all — "Jobs recommended for you",
   * "People you may know", "Add to your feed". Named by its own first line.
   */
  RECOMMENDATION: 'recommendation',
  DIRECT: 'direct',
  UNKNOWN: 'unknown',
});

/** The categories that are somebody else's activity, under one tick box. */
export const ACTIVITY_CATEGORIES = Object.freeze([
  QUIET_CATEGORY.REACTION,
  QUIET_CATEGORY.COMMENT,
  QUIET_CATEGORY.REPOST,
  QUIET_CATEGORY.FOLLOWED_BY,
  QUIET_CATEGORY.OTHER_ACTIVITY,
]);

/** Every category that a tick box can hide. `direct` and `unknown` are not here. */
export const HIDEABLE_CATEGORIES = Object.freeze([
  ...ACTIVITY_CATEGORIES,
  QUIET_CATEGORY.PROMOTED,
  QUIET_CATEGORY.SUGGESTED,
  QUIET_CATEGORY.NOT_FOLLOWED,
  QUIET_CATEGORY.RECOMMENDATION,
  QUIET_CATEGORY.GROUP,
]);

/** Which tick box governs which category. */
export const QUIET_GROUP = Object.freeze({
  ACTIVITY: 'activity',
  PROMOTED: 'promoted',
  SUGGESTED: 'suggested',
  GROUPS: 'groups',
});

/**
 * Category → the tick box that hides it, or `null` for "never hidden".
 * @param {string} category
 * @returns {string|null}
 */
export function quietGroupOf(category) {
  if (category === QUIET_CATEGORY.PROMOTED) return QUIET_GROUP.PROMOTED;
  // A labelled suggestion and an unlabelled one are the same thing to a reader,
  // so one tick box governs both.
  if (
    category === QUIET_CATEGORY.SUGGESTED ||
    category === QUIET_CATEGORY.NOT_FOLLOWED ||
    category === QUIET_CATEGORY.RECOMMENDATION
  ) {
    return QUIET_GROUP.SUGGESTED;
  }
  if (category === QUIET_CATEGORY.GROUP) return QUIET_GROUP.GROUPS;
  if (ACTIVITY_CATEGORIES.includes(category)) return QUIET_GROUP.ACTIVITY;
  return null;
}

/** Where quiet feed keeps its two pieces of state. */
export const QUIET_FEED_KEYS = Object.freeze({
  SETTINGS: 'quietFeed.settings',
  HIDDEN: 'quietFeed.hidden',
});

/** On, hiding all three groups. The whole point is that it works unattended. */
export const QUIET_FEED_DEFAULTS = Object.freeze({
  enabled: true,
  activity: true,
  promoted: true,
  suggested: true,
  groups: true,
});

/** Days of counts kept in `quietFeed.hidden`. A week is plenty; it is a curio. */
export const QUIET_FEED_DAYS_KEPT = 7;

/**
 * Local `YYYY-MM-DD`, the key today's count is filed under.
 *
 * Local rather than UTC because "hid 23 posts today" is a sentence about the
 * reader's day, not about Greenwich.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
