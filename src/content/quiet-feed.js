/**
 * Quiet feed — the part unfollowing cannot do.
 *
 * Unfollow everybody and the Following list is empty; the feed is not. It
 * refills, immediately, with what the people you are still *connected* to have
 * been doing — liked, commented on, reposted — plus LinkedIn's suggestions and
 * its ads. None of that is anything you subscribed to, and there is no setting
 * on the site that turns it off. So this hides it in the page: every post that
 * arrives with a "why you are seeing this" header goes, and every post from
 * somebody you actually chose to follow stays.
 *
 * Everything it does is local and reversible:
 *
 *   - **It only ever adds a class.** Nothing is removed from the page, no
 *     request is sent, nothing is told to LinkedIn. One line at the top of the
 *     feed says how many went and turns them all back on for this page load.
 *   - **It never hides what it cannot read.** `classify.js` returns `unknown`
 *     for anything without an author block and `direct` for any header it does
 *     not recognise, and neither is ever hidden. The composer, the "Start a
 *     post" card and every other list item in the page are `unknown`.
 *   - **It survives the feed being a treadmill.** LinkedIn recycles post
 *     containers as you scroll — nodes appear and vanish constantly — so the
 *     work is done by a debounced MutationObserver, each container is
 *     classified once and marked with `data-quiet`, and counting is keyed off
 *     LinkedIn's own `componentkey` so a container that comes back is not
 *     counted twice.
 *   - **It stops when you leave the feed.** LinkedIn is a single-page app: the
 *     script is not reloaded when you navigate to a profile and back. Leaving
 *     `/feed` unhides everything and drops the banner; coming back picks up
 *     where it left off, and `stop()` disconnects the lot.
 *
 * The hiding itself is a class in `quiet-feed.css`, injected by the manifest
 * rather than by this file, so no inline style has to get past linkedin.com's
 * content security policy.
 */

import {
  ACTIVITY_CATEGORIES,
  HIDEABLE_CATEGORIES,
  QUIET_CATEGORY,
  MESSAGES,
  QUIET_FEED_DAYS_KEPT,
  QUIET_FEED_DEFAULTS,
  QUIET_FEED_KEYS,
  dayKey,
  quietGroupOf,
} from '../constants.js';
import { classifyPost } from './classify.js';

/** What each container gets marked with, so it is only ever read once. */
export const MARK_ATTR = 'data-quiet';

/** The one class that does the hiding. See `quiet-feed.css`. */
export const HIDDEN_CLASS = 'quiet-feed-hidden';

/** The one line at the top of the feed. */
export const BANNER_ID = 'quiet-feed-banner';

/** LinkedIn's feed posts. No class names — they are obfuscated — so, roles. */
export const POST_SELECTOR = 'div[role="listitem"]';

/** Mutations are batched for this long. The feed mutates a great deal. */
export const DEBOUNCE_MS = 150;

/** Counts are written no more often than this. */
export const PERSIST_DEBOUNCE_MS = 500;

/**
 * Component keys remembered before the set is dropped.
 *
 * Only used to stop a recycled container being counted twice, so forgetting is
 * cheap: the worst case is a long scroll counting a handful of posts again.
 */
export const SEEN_CAP = 5000;

/* ================================================================== */
/*  The sentence at the top of the feed                               */
/* ================================================================== */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Per-category counts → the four numbers the banner actually says.
 *
 * `suggested` and `not-followed` share a tick box but are counted apart: "5
 * from people you don't follow" is a different sentence from "5 suggested", and
 * on an emptied feed it is the bigger of the two by a distance.
 */
export function groupCounts(counts) {
  const sum = (categories) => categories.reduce((n, c) => n + (Number(counts[c]) || 0), 0);
  return {
    activity: sum(ACTIVITY_CATEGORIES),
    promoted: Number(counts[QUIET_CATEGORY.PROMOTED]) || 0,
    suggested: Number(counts[QUIET_CATEGORY.SUGGESTED]) || 0,
    notFollowed: Number(counts[QUIET_CATEGORY.NOT_FOLLOWED]) || 0,
    total: sum(HIDEABLE_CATEGORIES),
  };
}

/**
 * "Quiet feed: hid 12 posts (4 network activity, 3 promoted, 5 from people you
 * don't follow)."
 *
 * Only the groups that actually happened are named, so the line stays short on
 * a feed where one of them dominates.
 *
 * @param {object} counts per-category counts
 * @param {boolean} [revealed] whether "Show them" is currently on
 * @returns {string}
 */
export function bannerText(counts, revealed = false) {
  const { activity, promoted, suggested, notFollowed, total } = groupCounts(counts);
  const parts = [];
  if (activity) parts.push(`${activity} network activity`);
  if (promoted) parts.push(`${promoted} promoted`);
  if (suggested) parts.push(`${suggested} suggested`);
  if (notFollowed) parts.push(`${notFollowed} from people you don’t follow`);
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  return revealed
    ? `Quiet feed: showing ${plural(total, 'post')} it had hidden${detail}.`
    : `Quiet feed: hid ${plural(total, 'post')}${detail}.`;
}

/* ================================================================== */
/*  Small helpers                                                     */
/* ================================================================== */

/** `innerText` is the one that respects line breaks; jsdom only has the other. */
function textOf(node) {
  if (typeof node.innerText === 'string') return node.innerText;
  return node.textContent || '';
}

const emptyCounts = () => Object.fromEntries(HIDEABLE_CATEGORIES.map((c) => [c, 0]));

/** `chrome`, if there is one. Absent in unit tests that do not need it. */
function api() {
  return typeof chrome === 'undefined' ? null : chrome;
}

async function readStorage(keys) {
  const chromeApi = api();
  if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) return {};
  try {
    return (await chromeApi.storage.local.get(keys)) || {};
  } catch {
    return {};
  }
}

async function writeStorage(items) {
  const chromeApi = api();
  if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) return;
  try {
    await chromeApi.storage.local.set(items);
  } catch {
    /* A popup that is not open, a worker that is asleep. Neither matters. */
  }
}

/** Keep the newest few days and drop the rest. ISO dates sort as strings. */
export function pruneDays(hidden, keep = QUIET_FEED_DAYS_KEPT) {
  const days = Object.keys(hidden || {}).sort().reverse().slice(0, keep);
  return Object.fromEntries(days.map((day) => [day, hidden[day]]));
}

/* ================================================================== */
/*  The machine                                                       */
/* ================================================================== */

/**
 * Build a quiet feed. Nothing happens until `start()`.
 *
 * @param {{document?: Document, onFeed?: () => boolean}} [opts]
 *   `onFeed` decides whether the current URL is still the feed; the default
 *   reads `location`, and tests hand in their own.
 */
export function createQuietFeed(opts = {}) {
  const doc = opts.document || (typeof document === 'undefined' ? null : document);
  const isFeed = opts.onFeed || (() => /^\/feed(\/|$)/.test(location.pathname));

  let settings = { ...QUIET_FEED_DEFAULTS };
  /** Per page load, because the banner is about this page load. */
  let counts = emptyCounts();
  /** What of `counts` has already been added to today's total in storage. */
  let pushed = emptyCounts();
  /** "Show them" — this page load only, never stored. */
  let revealed = false;

  const seen = new Set();
  let observer = null;
  let timer = null;
  let persistTimer = null;
  let banner = null;
  let running = false;
  let onChanged = null;

  /* ---- reading the page ---------------------------------------- */

  const containers = () => {
    if (!doc) return [];
    const main = doc.querySelector('main');
    return Array.from((main || doc).querySelectorAll(POST_SELECTOR));
  };

  /** True the first time this particular post is seen, whatever its container. */
  const isNew = (node) => {
    const key =
      node.getAttribute('componentkey') ||
      node.getAttribute('data-id') ||
      node.getAttribute('data-urn');
    if (!key) return true;
    if (seen.has(key)) return false;
    if (seen.size >= SEEN_CAP) seen.clear();
    seen.add(key);
    return true;
  };

  const shouldHide = (category) => {
    if (!settings.enabled || revealed) return false;
    const group = quietGroupOf(category);
    return group !== null && settings[group] === true;
  };

  /* ---- the banner ------------------------------------------------ */

  const removeBanner = () => {
    if (banner) banner.remove();
    banner = null;
  };

  function paintBanner() {
    const { total } = groupCounts(counts);
    if (!doc || !settings.enabled || total === 0) {
      removeBanner();
      return;
    }
    if (!banner || !banner.isConnected) {
      banner = doc.createElement('div');
      banner.id = BANNER_ID;
      banner.className = 'quiet-feed-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('data-testid', BANNER_ID);

      const label = doc.createElement('span');
      label.className = 'quiet-feed-banner__text';

      const toggle = doc.createElement('button');
      toggle.type = 'button';
      toggle.className = 'quiet-feed-banner__toggle';
      toggle.setAttribute('data-testid', 'quiet-feed-toggle');
      toggle.addEventListener('click', () => {
        revealed = !revealed;
        run();
      });

      banner.append(label, toggle);
      const host = doc.querySelector('main') || doc.body;
      if (host) host.insertBefore(banner, host.firstChild);
    }
    // Only ever written when it actually changed. The observer below watches
    // the whole subtree, and the banner is in it: rewriting this text with the
    // same string would be a childList mutation, which would schedule another
    // pass, which would rewrite this text, for as long as the tab was open.
    const text = bannerText(counts, revealed);
    const label = revealed ? 'Hide them again' : 'Show them';
    if (banner.firstChild.textContent !== text) banner.firstChild.textContent = text;
    if (banner.lastChild.textContent !== label) banner.lastChild.textContent = label;
  }

  /* ---- counting -------------------------------------------------- */

  /**
   * Fold this page load's new hides into today's total and tell the popup.
   *
   * Deltas, not a snapshot: the count in storage is the day's, across every tab
   * and every reload, and this is one page load's contribution to it.
   */
  async function persist() {
    const delta = {};
    let any = 0;
    for (const category of HIDEABLE_CATEGORIES) {
      const d = counts[category] - pushed[category];
      if (d > 0) {
        delta[category] = d;
        any += d;
      }
    }
    if (!any) return;
    pushed = { ...counts };

    const key = dayKey();
    const stored = await readStorage(QUIET_FEED_KEYS.HIDDEN);
    const hidden = pruneDays({ ...(stored[QUIET_FEED_KEYS.HIDDEN] || {}) });
    const today = { ...emptyCounts(), ...(hidden[key] || {}) };
    for (const [category, d] of Object.entries(delta)) today[category] += d;
    today.total = groupCounts(today).total;
    hidden[key] = today;
    await writeStorage({ [QUIET_FEED_KEYS.HIDDEN]: hidden });

    const chromeApi = api();
    if (chromeApi && chromeApi.runtime && chromeApi.runtime.sendMessage) {
      try {
        await Promise.resolve(
          chromeApi.runtime.sendMessage({
            type: MESSAGES.QUIET_FEED_HIDDEN,
            day: key,
            total: today.total,
            counts: today,
          }),
        );
      } catch {
        /* Nobody is listening. That is the normal case. */
      }
    }
  }

  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, PERSIST_DEBOUNCE_MS);
  };

  /* ---- the pass over the feed ------------------------------------ */

  /** Undo everything on the page, without forgetting what we counted. */
  function unpaint() {
    removeBanner();
    for (const node of containers()) node.classList.remove(HIDDEN_CLASS);
  }

  /**
   * Classify what is new, hide what the tick boxes say to hide, redraw the line
   * at the top. Cheap enough to run on every batch of mutations.
   */
  function run() {
    if (!doc) return;
    if (!isFeed()) {
      unpaint();
      return;
    }
    let counted = false;
    for (const node of containers()) {
      let category = node.getAttribute(MARK_ATTR);
      if (!category) {
        category = classifyPost(textOf(node));
        node.setAttribute(MARK_ATTR, category);
        if (HIDEABLE_CATEGORIES.includes(category) && isNew(node)) {
          counts[category] += 1;
          counted = true;
        }
      }
      const hide = shouldHide(category);
      if (hide !== node.classList.contains(HIDDEN_CLASS)) {
        node.classList.toggle(HIDDEN_CLASS, hide);
      }
    }
    paintBanner();
    if (counted) schedulePersist();
  }

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, DEBOUNCE_MS);
  };

  /* ---- settings -------------------------------------------------- */

  async function loadSettings() {
    const stored = await readStorage(QUIET_FEED_KEYS.SETTINGS);
    settings = { ...QUIET_FEED_DEFAULTS, ...(stored[QUIET_FEED_KEYS.SETTINGS] || {}) };
    return settings;
  }

  /* ---- lifecycle -------------------------------------------------- */

  async function start() {
    if (running || !doc) return;
    running = true;

    await loadSettings();
    if (!running) return; // stopped while the read was in flight

    const chromeApi = api();
    if (chromeApi && chromeApi.storage && chromeApi.storage.onChanged) {
      onChanged = (changes, area) => {
        if (area && area !== 'local') return;
        if (!changes || !changes[QUIET_FEED_KEYS.SETTINGS]) return;
        settings = {
          ...QUIET_FEED_DEFAULTS,
          ...(changes[QUIET_FEED_KEYS.SETTINGS].newValue || {}),
        };
        // A change of mind un-reveals: the tick boxes are the standing answer.
        revealed = false;
        run();
      };
      chromeApi.storage.onChanged.addListener(onChanged);
    }

    const target = doc.body || doc.documentElement;
    if (target && typeof MutationObserver === 'function') {
      observer = new MutationObserver(schedule);
      observer.observe(target, { childList: true, subtree: true });
    }

    run();
  }

  /** Disconnect everything and put the page back as it was. */
  function stop() {
    running = false;
    if (observer) observer.disconnect();
    observer = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    const chromeApi = api();
    if (onChanged && chromeApi && chromeApi.storage && chromeApi.storage.onChanged) {
      chromeApi.storage.onChanged.removeListener(onChanged);
    }
    onChanged = null;
    seen.clear();
    unpaint();
  }

  return {
    start,
    stop,
    /** Run a pass now, skipping the debounce. Tests and the banner use it. */
    refresh: run,
    counts: () => ({ ...counts }),
    settings: () => ({ ...settings }),
    isRevealed: () => revealed,
    banner: () => banner,
  };
}

/* ------------------------------------------------------------------ */
/*  The page itself. Absent in tests, which call `createQuietFeed`.    */
/* ------------------------------------------------------------------ */

const onLinkedIn =
  typeof location !== 'undefined' && /(^|\.)linkedin\.com$/i.test(location.hostname || '');

if (onLinkedIn && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
  createQuietFeed().start();
}
