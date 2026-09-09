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
