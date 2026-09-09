/**
 * LinkedIn Unfollow — the engine, and the router the popup talks to.
 *
 * The default route is the two calls linkedin.com's own Following page makes,
 * replayed from the service worker with your own cookies (see `linkedin.js`).
 * No tab has to stay open, the count is a single request, and one unfollow is
 * one POST rather than a click and a three-second wait for a label to flip.
 *
 * That speed is exactly why the rest of this file is guard rails:
 *
 *   1. **Never more than you asked for.** `limit` stops the run after N
 *      successful unfollows. The popup fills it in with 25, and you can set it
 *      to 1 and check that one person really is unfollowed.
 *   2. **You can look before you leap.** `preview` reads the identical list by
 *      the identical call and returns the names it *would* unfollow, without
 *      sending a single POST.
 *   3. **Stop at the first sign of trouble.** 429, 451, 401 and 403 end the run
 *      on the spot, and so do two non-200s in a row. Nothing is retried.
 *   4. **You can stop it.** The popup's Stop button sets a flag the loop checks
 *      before every person, so a run winds down within one request.
 *
 * Pacing is 0.8–1.6 seconds, randomised, one request at a time — the shape of
 * a person working through the list, not a script hammering an endpoint.
 *
 * The old click-the-page engine is still here as `dom-fallback.js`, for the day
 * LinkedIn rotates the query id out from under the list call.
 */

import {
  MESSAGES,
  PACING,
  PROGRESS_EVERY,
  STOPPED,
  UNFOLLOW_LIMIT_MAX,
  UNFOLLOW_SAMPLE_MAX,
} from './constants.js';
import {
  FATAL_REASONS,
  FATAL_STATUSES,
  PAGE_SIZE,
  csrfToken,
  fetchFollowingPage,
  postUnfollow,
} from './linkedin.js';
import * as domFallback from './dom-fallback.js';

/** Two failures in a row and we stop guessing why. */
export const CONSECUTIVE_FAILURE_LIMIT = 2;

/** Names carried back to the popup. A 5,000-name array helps nobody. */
export const NAME_CAP = 500;

/** Pages read before we accept the list has ended, whatever the total says. */
const MAX_PAGES = 600;

/* ---- Injectable sleep (tests replace it; production waits for real) ---- */

let sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function setSleepFn(fn) {
  sleepFn = typeof fn === 'function' ? fn : (ms) => new Promise((r) => setTimeout(r, ms));
}

const sleep = (ms) => sleepFn(ms);

/** A randomised human-ish gap. */
export function nextDelayMs() {
  return PACING.minDelayMs + Math.random() * (PACING.maxDelayMs - PACING.minDelayMs);
}

/* ================================================================== */
/*  The stop flag                                                     */
/* ================================================================== */

/**
 * Set by the Stop button, read by the loop before every person.
 *
 * A run cannot be killed mid-request — that would leave you not knowing whether
 * the last unfollow landed — so Stop means "after this one".
 */
let stopRequested = false;
let running = false;

export function requestStop() {
  stopRequested = true;
  return { running };
}

export function isRunning() {
  return running;
}

/** Test seam, and what every run does before it starts. */
export function resetStop() {
  stopRequested = false;
}

/* ================================================================== */
/*  Counting                                                          */
/* ================================================================== */

/**
 * How many people you follow, plus the first few names.
 *
 * One request. The number is LinkedIn's own `totalResultCount`, so it is the
 * whole list rather than however much a page has scrolled into view.
 *
 * @returns {Promise<{count: number, sample: string[]}>}
 */
export async function count() {
  const token = await csrfToken();
  const page = await fetchFollowingPage({ start: 0, count: PAGE_SIZE, token });

  if (page.status !== 200) throw new Error(statusMessage(page.status));

  return {
    count: page.total === null ? page.people.length : page.total,
    sample: page.people.slice(0, UNFOLLOW_SAMPLE_MAX).map((person) => person.name),
  };
}

/** A sentence for a status code, so no raw number ever reaches the popup. */
function statusMessage(status) {
  if (FATAL_REASONS[status]) return FATAL_REASONS[status];
  return `LinkedIn answered ${status} — stopped there.`;
}

/* ================================================================== */
/*  The run                                                           */
/* ================================================================== */

/**
 * Unfollow up to `limit` people, or preview who they would be.
 *
 * The list is re-read from `start: 0` on every page rather than walked with a
 * cursor, because unfollowing removes people from it: after ten unfollows the
 * next ten are at the top again. A preview, which removes nobody, pages
 * forward normally.
 *
 * @param {{limit?: number, dryRun?: boolean}} params
 * @returns {Promise<{unfollowed: number, attempted: number, names: string[],
 *   total: number|null, stopped: string, error?: string}>}
 */
export async function unfollowAll(params = {}) {
  const asked = Number(params.limit);
  const limit =
    Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), UNFOLLOW_LIMIT_MAX)
      : UNFOLLOW_LIMIT_MAX;
  const dryRun = !!params.dryRun;

  const token = await csrfToken();

  const names = [];
  let unfollowed = 0;
  let attempted = 0;
  let total = null;
  let failures = 0;
  let stopped = STOPPED.END;
  let error = null;

  resetStop();
  running = !dryRun;

  try {
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (stopRequested) {
        stopped = STOPPED.STOPPED;
        break;
      }

      // eslint-disable-next-line no-await-in-loop
      const batch = await fetchFollowingPage({ start, count: PAGE_SIZE, token });
      if (batch.total !== null) total = batch.total;

      if (batch.status !== 200) {
        stopped = STOPPED.ERROR;
        error = statusMessage(batch.status);
        break;
      }
      if (!batch.people.length) {
        stopped = STOPPED.END;
        break;
      }

      let progressed = false;

      for (const person of batch.people) {
        if (stopRequested) {
          stopped = STOPPED.STOPPED;
          break;
        }
        if ((dryRun ? names.length : unfollowed) >= limit) {
          stopped = STOPPED.LIMIT;
          break;
        }

        if (dryRun) {
          if (names.length < NAME_CAP) names.push(person.name);
          progressed = true;
          continue;
        }

        attempted += 1;
        // eslint-disable-next-line no-await-in-loop
        const result = await postUnfollow({ urn: person.urn, token });

        if (FATAL_STATUSES.includes(result.status)) {
          stopped = STOPPED.ERROR;
          error = statusMessage(result.status);
          break;
        }

        if (result.ok) {
          failures = 0;
          unfollowed += 1;
          progressed = true;
          if (names.length < NAME_CAP) names.push(person.name);
          if (unfollowed % PROGRESS_EVERY === 0) {
            announce({ unfollowed, attempted, total });
          }
        } else {
          failures += 1;
          if (failures >= CONSECUTIVE_FAILURE_LIMIT) {
            stopped = STOPPED.ERROR;
            error = `LinkedIn refused two requests in a row (last: ${result.status}) — stopped there.`;
            break;
          }
        }

        if (unfollowed < limit) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(nextDelayMs());
        }
      }

      if (stopped !== STOPPED.END) break;
      if ((dryRun ? names.length : unfollowed) >= limit) {
        stopped = STOPPED.LIMIT;
        break;
      }

      // A preview walks forward; a real run keeps re-reading the top, because
      // the people it just unfollowed are no longer on the list.
      if (dryRun) start += PAGE_SIZE;
      else if (!progressed) start += PAGE_SIZE; // nothing landed: do not spin on the same page

      // eslint-disable-next-line no-await-in-loop
      if (!dryRun) await sleep(nextDelayMs());
    }
  } finally {
    running = false;
    resetStop();
  }

  if (!dryRun) announce({ unfollowed, attempted, total });

  const out = { unfollowed, attempted, names, total, stopped };
  if (error) out.error = error;
  return out;
}

/** Tell the popup how far we are. It is very often closed; that is fine. */
function announce(progress) {
  Promise.resolve(
    chrome.runtime.sendMessage({ type: MESSAGES.PROGRESS, ...progress }),
  ).catch(() => {});
}

/* ================================================================== */
/*  Message router                                                    */
/* ================================================================== */

/**
 * Four messages, and nothing else. Anything the popup does not send is an
 * error rather than a silent no-op, so a typo surfaces in the popup instead of
 * as a button that quietly does nothing.
 *
 * `mode: 'dom'` on any of the first three runs the click-the-page fallback
 * instead — same answers, same shape, a great deal slower.
 *
 * @param {{type: string, limit?: number, mode?: string}} message
 * @returns {Promise<object>}
 */
export async function handleMessage(message) {
  const type = message && message.type;
  const dom = message && message.mode === 'dom';

  switch (type) {
    case MESSAGES.COUNT:
      return dom ? domFallback.unfollowCount() : count();
    case MESSAGES.PREVIEW:
      return dom
        ? domFallback.unfollowAll({ limit: message.limit, dryRun: true })
        : unfollowAll({ limit: message.limit, dryRun: true });
    case MESSAGES.UNFOLLOW:
      return dom
        ? domFallback.unfollowAll({ limit: message.limit })
        : unfollowAll({ limit: message.limit });
    case MESSAGES.STOP:
      return requestStop();
    default:
      throw new Error(`Unknown message: ${String(type)}`);
  }
}

/** Returning `true` keeps the message channel open for the async reply. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Progress is the worker talking to the popup; it is not a request for us.
  if (!message || message.type === MESSAGES.PROGRESS) return false;
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: (error && error.message) || String(error) }));
  return true;
});
