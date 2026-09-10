/**
 * The content script, against a fake feed.
 *
 * jsdom has no `innerText`, which is the property the real thing reads, so the
 * helper below defines one on every item — which also makes the dependency
 * explicit: quiet feed reads rendered lines, not markup.
 *
 * What is under test is the part that could go wrong in somebody's browser:
 * that only the categories the tick boxes name are hidden, that the composer
 * and everything else in the list is left alone, that the banner counts what it
 * hid and can put it back, that a tick in the popup lands in an open tab, that
 * the treadmill of a scrolling feed is kept up with, and that navigating away
 * puts the page back as it was.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { QUIET_CATEGORY, QUIET_FEED_KEYS, dayKey } from '../src/constants.js';
import {
  BANNER_ID,
  HIDDEN_CLASS,
  MARK_ATTR,
  bannerText,
  createQuietFeed,
  groupCounts,
  pruneDays,
} from '../src/content/quiet-feed.js';

/* ------------------------------------------------------------------ */
/*  A feed                                                             */
/* ------------------------------------------------------------------ */

/** One `div[role="listitem"]` whose `innerText` is what a real one's would be. */
function item(text, attrs = {}) {
  const node = document.createElement('div');
  node.setAttribute('role', 'listitem');
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.textContent = text;
  Object.defineProperty(node, 'innerText', { value: text, configurable: true });
  return node;
}

const body = 'A thought about the thing.\n41 reactions · 3 comments';

/** A post as innerText renders it: prefix, optional header, author block, post. */
const feedPost = (header, author = 'Marcus Webb', degree = '• 2nd') =>
  ['Feed post', header, author, degree, 'Head of Data at Northwind', '3h •', body]
    .filter(Boolean)
    .join('\n');

/** A post from somebody you do not follow: no header, but a Follow button. */
const unfollowedPost = (author = 'Aly Moursy') =>
  ['Feed post', author, '• 3rd+', 'Founder & CEO, Veeza AI', '1d • Edited •', 'Follow', body].join(
    '\n',
  );

/** A post in a group: the group's name, then the author's name and degree together. */
const groupPost = (group = 'The Recruitment Network', author = 'Tariq Mahmood') =>
  ['Feed post', group, `${author} • 3rd+`, '1h • Edited •', body].join('\n');

/** A recommendation module: no author, no author block, its name on line one. */
const jobsModule = () =>
  ['Feed post', 'Jobs recommended for you', 'AI Engineer (Agents)', 'Vellum Ltd · Remote'].join(
    '\n',
  );

/** The eleven items the tests start from: eight hideable, three not. */
const FEED = [
  ['start', 'Start a post\nVideo\nPhoto\nWrite article', QUIET_CATEGORY.UNKNOWN],
  ['like', feedPost('Priya Raman likes this'), QUIET_CATEGORY.REACTION],
  ['direct', feedPost(null, 'Loves Dale'), QUIET_CATEGORY.DIRECT],
  ['comment', feedPost('Priya Raman and 3 others commented'), QUIET_CATEGORY.COMMENT],
  ['ad', feedPost('Promoted', 'Northwind Analytics', '• Following'), QUIET_CATEGORY.PROMOTED],
  ['repost', feedPost('Sam Okafor reposted this'), QUIET_CATEGORY.REPOST],
  ['suggested', feedPost('Suggested'), QUIET_CATEGORY.SUGGESTED],
  ['unfollowed', unfollowedPost(), QUIET_CATEGORY.NOT_FOLLOWED],
  ['group', groupPost(), QUIET_CATEGORY.GROUP],
  ['jobs', jobsModule(), QUIET_CATEGORY.RECOMMENDATION],
  ['sort', 'Sort by: Top\nRecent', QUIET_CATEGORY.UNKNOWN],
];

let main;
let quiet;

/** Build the page and hand back a lookup by the name in `FEED`. */
function buildFeed(rows = FEED) {
  main = document.createElement('main');
  document.body.appendChild(main);
  const byName = {};
  for (const [name, text] of rows) {
    const node = item(text, { componentkey: `urn:${name}` });
    byName[name] = node;
    main.appendChild(node);
  }
  return byName;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Longer than the mutation debounce. */
const settle = () => wait(220);
const banner = () => document.getElementById(BANNER_ID);
const hidden = () => Array.from(main.querySelectorAll(`.${HIDDEN_CLASS}`));
const isHidden = (node) => node.classList.contains(HIDDEN_CLASS);

/** Always on the feed, unless a test says otherwise. */
async function startQuiet(opts = {}) {
  quiet = createQuietFeed({ onFeed: () => true, ...opts });
  await quiet.start();
  return quiet;
}

beforeEach(() => {
  document.body.textContent = '';
  quiet = null;
});

afterEach(() => {
  if (quiet) quiet.stop();
});

/* ================================================================== */
/*  What it hides                                                     */
/* ================================================================== */

describe('a feed of eleven', () => {
  it('hides the eight LinkedIn put there and leaves the other three', async () => {
    const nodes = buildFeed();
    await startQuiet();

    expect(hidden().map((n) => n.getAttribute(MARK_ATTR)).sort()).toEqual([
      'comment',
      'group',
      'not-followed',
      'promoted',
      'reaction',
      'recommendation',
      'repost',
      'suggested',
    ]);
    expect(isHidden(nodes.direct)).toBe(false);
    expect(isHidden(nodes.start)).toBe(false);
    expect(isHidden(nodes.sort)).toBe(false);
  });

  it('marks each item once, with what it decided', async () => {
    const nodes = buildFeed();
    await startQuiet();

    for (const [name, , category] of FEED) {
      expect(nodes[name].getAttribute(MARK_ATTR)).toBe(category);
    }
  });

  it('leaves the composer and the other non-posts exactly as they were', async () => {
    const nodes = buildFeed();
    const before = nodes.start.innerText;
    await startQuiet();

    expect(nodes.start.getAttribute(MARK_ATTR)).toBe(QUIET_CATEGORY.UNKNOWN);
    expect(isHidden(nodes.start)).toBe(false);
    expect(nodes.start.innerText).toBe(before);
    expect(nodes.start.isConnected).toBe(true);
  });

  it('says what it did, in one line, at the top of the feed', async () => {
    buildFeed();
    await startQuiet();

    expect(banner()).not.toBe(null);
    expect(main.firstChild).toBe(banner());
    expect(banner().firstChild.textContent).toBe(
      'Quiet feed: hid 8 posts (3 network activity, 1 promoted, 1 suggested, 1 recommendation, 1 from people you don’t follow, 1 from groups).',
    );
    expect(banner().lastChild.textContent).toBe('Show them');
  });

  it('says nothing at all when there was nothing to hide', async () => {
    buildFeed([
      ['direct', feedPost(null), QUIET_CATEGORY.DIRECT],
      ['start', 'Start a post', QUIET_CATEGORY.UNKNOWN],
    ]);
    await startQuiet();

    expect(banner()).toBe(null);
  });
});

/* ================================================================== */
/*  Show them                                                         */
/* ================================================================== */

describe('“Show them”', () => {
  it('puts every hidden post back for this page load, and takes them away again', async () => {
    const nodes = buildFeed();
    await startQuiet();
    expect(hidden()).toHaveLength(8);

    banner().lastChild.click();
    expect(hidden()).toHaveLength(0);
    expect(isHidden(nodes.ad)).toBe(false);
    expect(banner().lastChild.textContent).toBe('Hide them again');
    expect(banner().firstChild.textContent).toBe(
      'Quiet feed: showing 8 posts it had hidden (3 network activity, 1 promoted, 1 suggested, 1 recommendation, 1 from people you don’t follow, 1 from groups).',
    );

    banner().lastChild.click();
    expect(hidden()).toHaveLength(8);
    expect(banner().lastChild.textContent).toBe('Show them');
  });

  it('does not thrash: a settled feed stops mutating itself', async () => {
    buildFeed();
    await startQuiet();
    await settle();

    const seen = [];
    const spy = new MutationObserver((records) => seen.push(...records));
    spy.observe(main, { childList: true, subtree: true });
    await settle();
    spy.disconnect();

    expect(seen).toHaveLength(0);
  });

  it('does not reclassify anything on the way back', async () => {
    const nodes = buildFeed();
    await startQuiet();
    banner().lastChild.click();
    banner().lastChild.click();

    expect(quiet.counts().reaction).toBe(1);
    expect(nodes.like.getAttribute(MARK_ATTR)).toBe(QUIET_CATEGORY.REACTION);
  });
});

/* ================================================================== */
/*  The tick boxes                                                    */
/* ================================================================== */

describe('a tick in the popup', () => {
  it('reaches an open tab without a reload', async () => {
    const nodes = buildFeed();
    await startQuiet();
    expect(isHidden(nodes.ad)).toBe(true);

    await chrome.storage.local.set({
      [QUIET_FEED_KEYS.SETTINGS]: {
        enabled: true,
        activity: true,
        promoted: false,
        suggested: true,
      },
    });

    expect(isHidden(nodes.ad)).toBe(false);
    expect(isHidden(nodes.like)).toBe(true);
    expect(isHidden(nodes.suggested)).toBe(true);
  });

  it('turning the whole thing off shows everything and drops the line', async () => {
    buildFeed();
    await startQuiet();

    await chrome.storage.local.set({
      [QUIET_FEED_KEYS.SETTINGS]: { enabled: false },
    });

    expect(hidden()).toHaveLength(0);
    expect(banner()).toBe(null);
  });

  it('untick "Network activity" and the ad, the suggestions and the group stay hidden', async () => {
    const nodes = buildFeed();
    await startQuiet();

    await chrome.storage.local.set({
      [QUIET_FEED_KEYS.SETTINGS]: {
        enabled: true,
        activity: false,
        promoted: true,
        suggested: true,
      },
    });

    expect(hidden().map((n) => n.getAttribute(MARK_ATTR)).sort()).toEqual([
      'group',
      'not-followed',
      'promoted',
      'recommendation',
      'suggested',
    ]);
    expect(isHidden(nodes.comment)).toBe(false);
  });

  it('is read from storage before the first pass, so a tab opens settled', async () => {
    await chrome.storage.local.set({
      [QUIET_FEED_KEYS.SETTINGS]: {
        enabled: true,
        activity: false,
        promoted: false,
        suggested: false,
        groups: false,
      },
    });
    buildFeed();
    await startQuiet();

    expect(hidden()).toHaveLength(0);
    expect(quiet.settings().activity).toBe(false);
  });
});

/* ================================================================== */
/*  The treadmill                                                     */
/* ================================================================== */

describe('LinkedIn’s virtual scrolling', () => {
  it('picks up items appended after the first pass', async () => {
    buildFeed();
    await startQuiet();
    expect(hidden()).toHaveLength(8);

    main.append(
      item(feedPost('Dana Choi likes this'), { componentkey: 'urn:extra-1' }),
      item(feedPost('Promoted', 'Vellum Ltd', '• Following'), { componentkey: 'urn:extra-2' }),
      item(feedPost(null, 'Ines Duarte'), { componentkey: 'urn:extra-3' }),
    );
    await settle();

    expect(hidden()).toHaveLength(10);
    expect(banner().firstChild.textContent).toBe(
      'Quiet feed: hid 10 posts (4 network activity, 2 promoted, 1 suggested, 1 recommendation, 1 from people you don’t follow, 1 from groups).',
    );
  });

  it('hides a post the moment it is inserted, not a debounce later', async () => {
    buildFeed([]);
    await startQuiet();
    expect(banner()).toBe(null);

    const node = item(feedPost('Dana Choi likes this'), { componentkey: 'urn:sync' });
    main.appendChild(node);
    await wait(0); // far short of the 150 ms debounce

    expect(node.getAttribute(MARK_ATTR)).toBe(QUIET_CATEGORY.REACTION);
    expect(isHidden(node)).toBe(true);
    // The banner is the part that waits, so it has not caught up yet.
    expect(banner()).toBe(null);

    await settle();
    expect(banner().firstChild.textContent).toBe(
      'Quiet feed: hid 1 post (1 network activity).',
    );
  });

  it('classifies a post inserted inside a wrapper, not only a bare one', async () => {
    buildFeed([]);
    await startQuiet();

    const wrapper = document.createElement('div');
    wrapper.appendChild(item(groupPost(), { componentkey: 'urn:wrapped' }));
    main.appendChild(wrapper);
    await wait(0);

    const node = main.querySelector('[componentkey="urn:wrapped"]');
    expect(node.getAttribute(MARK_ATTR)).toBe(QUIET_CATEGORY.GROUP);
    expect(isHidden(node)).toBe(true);
  });

  it('does not count a post twice when its container comes back', async () => {
    const nodes = buildFeed();
    await startQuiet();
    expect(quiet.counts().reaction).toBe(1);

    nodes.like.remove();
    await settle();
    main.appendChild(item(feedPost('Priya Raman likes this'), { componentkey: 'urn:like' }));
    await settle();

    expect(quiet.counts().reaction).toBe(1);
    expect(hidden()).toHaveLength(8);
  });

  it('re-hides a recycled container, mark and all', async () => {
    const nodes = buildFeed();
    await startQuiet();
    nodes.ad.remove();
    await settle();

    const returned = item(feedPost('Promoted', 'Northwind Analytics', '• Following'), {
      componentkey: 'urn:ad',
    });
    main.appendChild(returned);
    await settle();

    expect(returned.getAttribute(MARK_ATTR)).toBe(QUIET_CATEGORY.PROMOTED);
    expect(isHidden(returned)).toBe(true);
  });
});

/* ================================================================== */
/*  Navigation                                                        */
/* ================================================================== */

describe('leaving the feed', () => {
  it('puts the page back, then picks up again on the way in', async () => {
    let onFeed = true;
    buildFeed();
    await startQuiet({ onFeed: () => onFeed });
    expect(hidden()).toHaveLength(8);

    onFeed = false;
    main.appendChild(item('Sort by: Top'));
    await settle();

    expect(hidden()).toHaveLength(0);
    expect(banner()).toBe(null);

    onFeed = true;
    main.appendChild(item(feedPost('Dana Choi likes this'), { componentkey: 'urn:back' }));
    await settle();

    expect(hidden()).toHaveLength(9);
    expect(banner()).not.toBe(null);
  });

  it('stop() disconnects the observer and leaves nothing behind', async () => {
    buildFeed();
    await startQuiet();
    expect(hidden()).toHaveLength(8);

    quiet.stop();
    expect(hidden()).toHaveLength(0);
    expect(banner()).toBe(null);

    main.appendChild(item(feedPost('Dana Choi likes this'), { componentkey: 'urn:after-stop' }));
    await settle();
    expect(hidden()).toHaveLength(0);

    quiet = null; // afterEach has nothing left to do
  });

  it('stops listening to the popup once it has stopped', async () => {
    buildFeed();
    await startQuiet();
    quiet.stop();

    await chrome.storage.local.set({
      [QUIET_FEED_KEYS.SETTINGS]: { enabled: true, activity: true, promoted: true },
    });
    expect(hidden()).toHaveLength(0);
    quiet = null;
  });
});

/* ================================================================== */
/*  The tally                                                         */
/* ================================================================== */

describe('the count it keeps', () => {
  it('files today’s hides under today, and tells the popup', async () => {
    chrome.runtime.sendMessage = vi.fn(async () => undefined);
    buildFeed();
    await startQuiet();
    await wait(700);

    const stored = await chrome.storage.local.get(QUIET_FEED_KEYS.HIDDEN);
    const today = stored[QUIET_FEED_KEYS.HIDDEN][dayKey()];
    expect(today.total).toBe(8);
    expect(today.reaction).toBe(1);
    expect(today.promoted).toBe(1);
    expect(today.suggested).toBe(1);

    const sent = chrome.runtime.sendMessage.mock.calls.map(([m]) => m);
    expect(sent.some((m) => m.type === 'quietFeedHidden' && m.total === 8)).toBe(true);
  });

  it('adds to a day that already has a tally rather than replacing it', async () => {
    await chrome.storage.local.set({
      [QUIET_FEED_KEYS.HIDDEN]: { [dayKey()]: { reaction: 4, total: 4 } },
    });
    buildFeed();
    await startQuiet();
    await wait(700);

    const stored = await chrome.storage.local.get(QUIET_FEED_KEYS.HIDDEN);
    const today = stored[QUIET_FEED_KEYS.HIDDEN][dayKey()];
    expect(today.reaction).toBe(5);
    expect(today['not-followed']).toBe(1);
    expect(today.total).toBe(12);
  });

  it('keeps a week of days and no more', () => {
    const days = {};
    for (let i = 1; i <= 12; i += 1) days[`2026-09-${String(i).padStart(2, '0')}`] = { total: i };
    const kept = Object.keys(pruneDays(days));
    expect(kept).toHaveLength(7);
    expect(kept).toContain('2026-09-12');
    expect(kept).not.toContain('2026-09-05');
  });
});

/* ================================================================== */
/*  The sentence                                                      */
/* ================================================================== */

describe('the banner’s sentence', () => {
  it('adds up the activity categories into one number', () => {
    const counts = { reaction: 9, comment: 5, repost: 3, 'followed-by': 1, promoted: 3, suggested: 2 };
    expect(groupCounts(counts)).toMatchObject({
      activity: 18,
      promoted: 3,
      suggested: 2,
      total: 23,
    });
    expect(bannerText(counts)).toBe(
      'Quiet feed: hid 23 posts (18 network activity, 3 promoted, 2 suggested).',
    );
  });

  it('names only the groups that happened', () => {
    expect(bannerText({ promoted: 4 })).toBe('Quiet feed: hid 4 posts (4 promoted).');
    expect(bannerText({ reaction: 1 })).toBe(
      'Quiet feed: hid 1 post (1 network activity).',
    );
    expect(bannerText({ group: 6 })).toBe('Quiet feed: hid 6 posts (6 from groups).');
    expect(bannerText({ recommendation: 1 })).toBe('Quiet feed: hid 1 post (1 recommendation).');
    expect(bannerText({ recommendation: 4, group: 2 })).toBe(
      'Quiet feed: hid 6 posts (4 recommendations, 2 from groups).',
    );
  });
});
