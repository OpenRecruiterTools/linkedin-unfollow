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
 * A run has one source by default and two when you ask for `scope: 'everyone'`:
 * first LinkedIn's Following list, then a page-by-page scan of your *followers*,
 * because your connections are followed automatically and never appear on the
 * Following list (see `linkedin.js`). The second pass reads at 0.4–0.8 seconds a
 * page, unfollows only the followers whose own `following` flag is still true,
 * skips anyone the first pass already handled, and is governed by exactly the
 * same limit, stop flag and failure counter as the first.
 *
 * The old click-the-page engine is still here as `dom-fallback.js`, for the day
 * LinkedIn rotates the query id out from under the list call.
 */

import {
  FAST_PACING,
  FAST_STREAMS,
  MESSAGES,
  PACING,
  PHASE,
  PROGRESS_EVERY,
  SCAN_PACING,
  SCOPE,
  SPEED,
  STOPPED,
  UNFOLLOW_LIMIT_MAX,
  UNFOLLOW_SAMPLE_MAX,
} from './constants.js';
import {
  FATAL_REASONS,
  FATAL_STATUSES,
  FOLLOWERS_PAGE_SIZE,
  PAGE_SIZE,
  csrfToken,
  fetchFollowersPage,
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

/**
 * Followers pages read before we accept that list has ended.
 *
 * Fifty a page, so this is 50,000 followers — well past the account this was
 * built for, and a hard stop rather than a loop that could run all day.
 */
const MAX_SCAN_PAGES = 1000;

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

/** The gap one `fast` stream leaves between its own requests. */
export function nextFastDelayMs() {
  return FAST_PACING.minDelayMs + Math.random() * (FAST_PACING.maxDelayMs - FAST_PACING.minDelayMs);
}

/** The same idea, between followers pages: a read is cheaper than a write. */
export function nextScanDelayMs() {
  return SCAN_PACING.minDelayMs + Math.random() * (SCAN_PACING.maxDelayMs - SCAN_PACING.minDelayMs);
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
 * With `scope: 'everyone'` it also scans your followers, page by page, to find
 * how many of them you are still following — the connections the Following list
 * never shows. That is one read per fifty followers (190 of them for 9,479)
 * rather than a single request, so it announces progress as it goes and takes a
 * couple of minutes. Nothing is unfollowed either way.
 *
 * @param {{scope?: string}} [params]
 * @returns {Promise<{count: number, sample: string[],
 *   followers?: {total: number|null, stillFollowing: number}}>}
 */
export async function count(params = {}) {
  const token = await csrfToken();
  const page = await fetchFollowingPage({ start: 0, count: PAGE_SIZE, token });

  if (page.status !== 200) throw new Error(statusMessage(page.status));

  const out = {
    count: page.total === null ? page.people.length : page.total,
    sample: page.people.slice(0, UNFOLLOW_SAMPLE_MAX).map((person) => person.name),
  };

  if (params.scope !== SCOPE.EVERYONE) return out;

  const scan = await scanFollowers(token);
  out.followers = { total: scan.total, stillFollowing: scan.stillFollowing };
  return out;
}

/**
 * Read the whole followers list without touching anything, counting the ones
 * you are still following.
 *
 * @param {string} token
 * @returns {Promise<{total: number|null, stillFollowing: number, scanned: number}>}
 */
async function scanFollowers(token) {
  let start = 0;
  let total = null;
  let stillFollowing = 0;
  let scanned = 0;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await fetchFollowersPage({ start, count: FOLLOWERS_PAGE_SIZE, token });
    if (batch.total !== null) total = batch.total;
    if (batch.status !== 200) throw new Error(statusMessage(batch.status));
    if (!batch.people.length) break;

    scanned += batch.people.length;
    for (const person of batch.people) if (person.following) stillFollowing += 1;
    announce({ phase: PHASE.SCANNING, scanned, followersTotal: total, unfollowed: 0 });

    start += FOLLOWERS_PAGE_SIZE;
    if (total !== null && start >= total) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(nextScanDelayMs());
  }

  return { total, stillFollowing, scanned };
}

/** A sentence for a status code, so no raw number ever reaches the popup. */
function statusMessage(status) {
  if (FATAL_REASONS[status]) return FATAL_REASONS[status];
  return `LinkedIn answered ${status} — stopped there.`;
}

/* ================================================================== */
/*  The bookkeeping every stream shares                               */
/* ================================================================== */

/**
 * End the run, once.
 *
 * The first reason wins: a 429 on one stream is what the run reports even
 * though the two streams beside it also notice, a moment later, that the run is
 * ending. `run.ending` is what every stream and the queue watch, and it is
 * separate from the Stop button's flag so that finishing one source cleanly
 * does not look like you pressed Stop.
 */
function endRun(run, how, error) {
  if (run.ending) return;
  run.ending = true;
  run.stopped = how;
  if (error) run.error = error;
}

/**
 * Take one of the run's `limit` slots, or refuse.
 *
 * A stream claims its slot *before* it sends anything, which is what keeps
 * three streams from between them overshooting a limit of five. A slot is given
 * back when the attempt does not land, because the limit counts unfollows, not
 * attempts.
 *
 * Being refused a slot does **not** end the run: with three streams and a limit
 * of one, two of them are refused before the third has sent anything, and if
 * either of those ended the run it would end at nought unfollowed. A refused
 * stream retires quietly and leaves `drain` to decide.
 */
function claimSlot(run) {
  if (run.claimed >= run.limit) {
    run.limitReached = true;
    return false;
  }
  run.claimed += 1;
  return true;
}

function releaseSlot(run) {
  run.claimed -= 1;
}

/**
 * The people on this page the run has not already claimed, marked as claimed.
 *
 * One `seen` set for the whole run: no two streams get the same person, and
 * nobody the Following list already covered is touched again when the followers
 * scan turns them up.
 */
function claimUnseen(run, people) {
  const fresh = [];
  for (const person of people) {
    if (run.seen.has(person.urn)) continue;
    run.seen.add(person.urn);
    fresh.push(person);
  }
  return fresh;
}

/**
 * How many people the run is working towards: the Following total, plus every
 * still-followed follower it has turned up so far. It grows during the scan
 * because until a followers page has been read, nobody knows what is on it.
 */
function totalOf(run) {
  if (run.followingTotal === null && !run.stillFollowing) return null;
  return (run.followingTotal || 0) + run.stillFollowing;
}

/** The heartbeat payload the unfollowing phases send. */
function progressOf(run) {
  return { unfollowed: run.unfollowed, attempted: run.attempted, total: totalOf(run) };
}

/** Tell the popup how far we are. It is very often closed; that is fine. */
function announce(progress) {
  Promise.resolve(
    chrome.runtime.sendMessage({ type: MESSAGES.PROGRESS, ...progress }),
  ).catch(() => {});
}

/* ================================================================== */
/*  The queue the streams pull from                                   */
/* ================================================================== */

/**
 * A queue of people, shared by every stream in the run, that refills itself one
 * page at a time.
 *
 * `readPage(start)` does the endpoint-specific part — fetch, claim, decide
 * where the next page starts — and the queue does the paging, the end-of-list
 * bookkeeping, and the mutual exclusion that keeps three streams from fetching
 * the same page three times: whoever finds the buffer empty fetches, and the
 * others wait on that same request.
 *
 * `maxPages` is the backstop: however a list misbehaves, a run reads a bounded
 * number of pages rather than going round for ever.
 *
 * @param {object} run
 * @param {(start: number) => Promise<{people?: object[], nextStart?: number,
 *   ended?: boolean, stop?: boolean}>} readPage
 * @param {number} maxPages
 */
function pageQueue(run, readPage, maxPages) {
  const buffer = [];
  let start = 0;
  let pages = 0;
  let ended = false;
  let filling = null;

  const fill = () => {
    if (!filling) {
      pages += 1;
      if (pages > maxPages) {
        ended = true;
        return Promise.resolve();
      }
      filling = readPage(start)
        .then((page) => {
          if (page.stop) {
            ended = true;
            return;
          }
          buffer.push(...(page.people || []));
          if (page.nextStart !== undefined) start = page.nextStart;
          if (page.ended) ended = true;
        })
        .finally(() => {
          filling = null;
        });
    }
    return filling;
  };

  return {
    /** The next person, or `null` when there is no next person. */
    async next() {
      for (;;) {
        if (run.ending) return null;
        if (buffer.length) return buffer.shift();
        if (ended) return null;
        // eslint-disable-next-line no-await-in-loop
        await fill();
      }
    },
  };
}

/**
 * Phase one's queue: LinkedIn's own Following list.
 *
 * A real run keeps re-reading the top of the list, because the people it just
 * unfollowed are no longer on it; a preview, and any page that turned up nobody
 * new, moves on instead — which is also what stops a page of failed unfollows
 * being read round and round.
 */
function followingQueue(run) {
  return pageQueue(run, async (start) => {
    const batch = await fetchFollowingPage({ start, count: PAGE_SIZE, token: run.token });
    if (batch.total !== null) run.followingTotal = batch.total;

    if (batch.status !== 200) {
      endRun(run, STOPPED.ERROR, statusMessage(batch.status));
      return { stop: true };
    }
    if (!batch.people.length) return { ended: true };

    const people = claimUnseen(run, batch.people);
    return {
      people,
      nextStart: run.dryRun || !people.length ? start + PAGE_SIZE : start,
    };
  }, MAX_PAGES);
}

/**
 * Phase two's queue: your followers, which is where your connections are.
 *
 * It always pages forward — unfollowing somebody does not stop them following
 * you, so nothing is removed underneath us — and hands on only the rows whose
 * own `following` flag is still true. Reading is what takes the time here, so
 * each page announces how far the scan has got.
 */
function followersQueue(run) {
  return pageQueue(run, async (start) => {
    const batch = await fetchFollowersPage({
      start,
      count: FOLLOWERS_PAGE_SIZE,
      token: run.token,
    });
    if (batch.total !== null) run.followersTotal = batch.total;

    if (batch.status !== 200) {
      endRun(run, STOPPED.ERROR, statusMessage(batch.status));
      return { stop: true };
    }
    if (!batch.people.length) return { ended: true };

    run.scanned += batch.people.length;
    const people = claimUnseen(run, batch.people).filter((person) => person.following);
    run.stillFollowing += people.length;

    announce({
      ...progressOf(run),
      phase: PHASE.SCANNING,
      scanned: run.scanned,
      followersTotal: run.followersTotal,
    });

    const nextStart = start + FOLLOWERS_PAGE_SIZE;
    const ended = run.followersTotal !== null && nextStart >= run.followersTotal;

    // The same gap between reads the count-only scan leaves, for the same
    // reason: this list is long, and 190 requests in a row is a burst.
    if (!ended) await sleep(nextScanDelayMs());

    return { people, nextStart, ended };
  }, MAX_SCAN_PAGES);
}

/* ================================================================== */
/*  One stream                                                        */
/* ================================================================== */

/**
 * One POST, and every reason it could end the run.
 *
 * @returns {Promise<boolean>} false when this stream must stop
 */
async function unfollowOne(run, person) {
  run.attempted += 1;
  const result = await postUnfollow({ urn: person.urn, token: run.token });

  if (FATAL_STATUSES.includes(result.status)) {
    endRun(run, STOPPED.ERROR, statusMessage(result.status));
    return false;
  }

  if (result.ok) {
    run.failures = 0;
    run.unfollowed += 1;
    if (run.names.length < NAME_CAP) run.names.push(person.name);
    if (run.unfollowed % PROGRESS_EVERY === 0) announce(progressOf(run));
    return true;
  }

  // It did not land, so it does not spend one of the run's slots.
  releaseSlot(run);
  run.failures += 1;
  if (run.failures >= CONSECUTIVE_FAILURE_LIMIT) {
    endRun(
      run,
      STOPPED.ERROR,
      `LinkedIn refused two requests in a row (last: ${result.status}) — stopped there.`,
    );
    return false;
  }
  return true;
}

/**
 * One stream: claim a slot, take the next person, unfollow, pause, repeat.
 *
 * A careful run is one of these. A fast run is three of them over the same
 * queue and the same slots, so the limit, the stop flag and the failure counter
 * are shared rather than multiplied.
 */
async function stream(run, queue, delayFn) {
  for (;;) {
    if (run.ending) return;
    if (stopRequested) {
      endRun(run, STOPPED.STOPPED);
      return;
    }
    // No slot left. Somebody else is using it: retire, and let `drain` decide.
    if (!claimSlot(run)) return;

    // eslint-disable-next-line no-await-in-loop
    const person = await queue.next();
    if (!person) {
      releaseSlot(run);
      endRun(run, STOPPED.END);
      return;
    }
    if (stopRequested) {
      releaseSlot(run);
      endRun(run, STOPPED.STOPPED);
      return;
    }

    if (run.dryRun) {
      if (run.names.length < NAME_CAP) run.names.push(person.name);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const carryOn = await unfollowOne(run, person);
    if (!carryOn) return;

    if (run.claimed < run.limit) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayFn());
    }
  }
}

/**
 * Work one source dry with `streams` streams, then come back.
 *
 * The limit is called here rather than in a stream, because a stream that is
 * refused a slot only knows that *somebody* has the last one, not whether they
 * finished with it. Once every stream is home, the run stopped at its limit if
 * a stream was refused and the slots that were claimed are all still spent —
 * `claimed` having fallen back below the limit means the list simply ran out.
 */
async function drain(run, queue, streams, delayFn) {
  run.ending = false;
  run.limitReached = false;
  await Promise.all(Array.from({ length: streams }, () => stream(run, queue, delayFn)));
  if (run.limitReached && run.claimed >= run.limit) endRun(run, STOPPED.LIMIT);
}

/* ================================================================== */
/*  The run                                                           */
/* ================================================================== */

/**
 * Unfollow up to `limit` people, or preview who they would be.
 *
 * One source by default; two when `scope` is `everyone`, and then the limit,
 * the stop flag, the seen set and the failure counter all carry across both of
 * them. `speed: 'fast'` runs three streams instead of one over each source.
 *
 * @param {{limit?: number, dryRun?: boolean, scope?: string, speed?: string}} params
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
  const everyone = params.scope === SCOPE.EVERYONE;
  // A preview sends nothing, so there is nothing for three streams to do.
  const fast = params.speed === SPEED.FAST && !dryRun;

  const token = await csrfToken();

  /** Everything the streams and the phases share, in one bag. */
  const run = {
    token,
    limit,
    dryRun,
    names: [],
    /** Profile urns already claimed, so nobody is handled twice. */
    seen: new Set(),
    unfollowed: 0,
    attempted: 0,
    /** Slots taken out of `limit`, held from before a POST until it fails. */
    claimed: 0,
    /** A stream asked for a slot and there was none: `drain` reads this. */
    limitReached: false,
    failures: 0,
    followingTotal: null,
    followersTotal: null,
    stillFollowing: 0,
    scanned: 0,
    ending: false,
    stopped: STOPPED.END,
    error: null,
  };

  resetStop();
  running = !dryRun;

  const streams = fast ? FAST_STREAMS : 1;
  const delayFn = fast ? nextFastDelayMs : nextDelayMs;

  try {
    await drain(run, followingQueue(run), streams, delayFn);
    if (everyone && run.stopped === STOPPED.END) {
      await drain(run, followersQueue(run), streams, delayFn);
    }
  } finally {
    running = false;
    resetStop();
  }

  if (!dryRun) announce(progressOf(run));

  const out = {
    unfollowed: run.unfollowed,
    attempted: run.attempted,
    names: run.names,
    total: totalOf(run),
    stopped: run.stopped,
  };
  if (run.error) out.error = run.error;
  return out;
}

/* ================================================================== */
/*  Message router                                                    */
/* ================================================================== */

/**
 * Four messages, and nothing else. Anything the popup does not send is an
 * error rather than a silent no-op, so a typo surfaces in the popup instead of
 * as a button that quietly does nothing.
 *
 * `scope: 'everyone'` on the first three adds the followers list as a second
 * source, and `speed: 'fast'` on `unfollow` runs three streams instead of one.
 * Both default to the old behaviour when they are left off.
 *
 * `mode: 'dom'` on any of the first three runs the click-the-page fallback
 * instead — same answers, same shape, a great deal slower, and Following-list
 * only: it has no followers page to click.
 *
 * @param {{type: string, limit?: number, mode?: string, scope?: string,
 *   speed?: string}} message
 * @returns {Promise<object>}
 */
export async function handleMessage(message) {
  const type = message && message.type;
  const dom = message && message.mode === 'dom';

  switch (type) {
    case MESSAGES.COUNT:
      return dom ? domFallback.unfollowCount() : count({ scope: message.scope });
    case MESSAGES.PREVIEW:
      return dom
        ? domFallback.unfollowAll({ limit: message.limit, dryRun: true })
        : unfollowAll({ limit: message.limit, dryRun: true, scope: message.scope });
    case MESSAGES.UNFOLLOW:
      return dom
        ? domFallback.unfollowAll({ limit: message.limit })
        : unfollowAll({ limit: message.limit, scope: message.scope, speed: message.speed });
    case MESSAGES.STOP:
      return requestStop();
    default:
      throw new Error(`Unknown message: ${String(type)}`);
  }
}

/**
 * Messages that pass through the worker rather than to it.
 *
 * Everything on this extension's message bus arrives here, including the two
 * one-way announcements meant for the popup. Answering those with "unknown
 * message" would be noise; ignoring them is the whole job.
 */
const BROADCASTS = new Set([MESSAGES.PROGRESS, MESSAGES.QUIET_FEED_HIDDEN]);

/** Returning `true` keeps the message channel open for the async reply. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Progress is the worker talking to the popup, and the quiet-feed count is
  // the content script talking to the popup. Neither is a request for us.
  if (!message || BROADCASTS.has(message.type)) return false;
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: (error && error.message) || String(error) }));
  return true;
});
