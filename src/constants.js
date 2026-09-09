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

/** Progress is announced this often, so a long run does not go quiet. */
export const PROGRESS_EVERY = 10;

/** How the run was ended. */
export const STOPPED = Object.freeze({
  LIMIT: 'limit',
  END: 'end',
  STOPPED: 'stopped',
  ERROR: 'error',
});
