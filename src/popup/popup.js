/**
 * The whole extension, as one screen.
 *
 * It is built around not being surprised. "Unfollow up to" is filled in with 25
 * so a first run is small — set it to 1 and check that one person really is
 * unfollowed before you trust it with 800. "Preview" makes the identical list
 * request and lists the names, sending no unfollow at all. Only then does the
 * red button, which says out loud how many it is about to unfollow and that
 * there is no undo. Once a run is going, Stop ends it after the person it is
 * on.
 *
 * The two tick boxes are both off by default, and both say what they cost:
 * "also unfollow my connections" adds a scan of your followers list, which is
 * where the state of your connections actually lives, and "fast" runs three
 * requests at a time instead of one.
 */

import {
  MESSAGES,
  PHASE,
  QUIET_FEED_DEFAULTS,
  QUIET_FEED_KEYS,
  SCOPE,
  SPEED,
  STOPPED,
  UNFOLLOW_LIMIT_DEFAULT,
  UNFOLLOW_LIMIT_MAX,
  UNFOLLOW_LIMIT_MIN,
  UNFOLLOW_SAMPLE_MAX,
  dayKey,
} from '../constants.js';
import { el, render, fmtNumber } from '../ui/dom.js';
import {
  busyButton,
  card,
  checkField,
  checkbox,
  confirmDialog,
  empty,
  errorLine,
  field,
  input,
  row,
  statusLine,
} from '../ui/components.js';

/** The bigger tool this one was carved out of. */
export const TOOLKIT_URL = 'https://github.com/OpenRecruiterTools/linkedin-toolkit';

/** Who built it. */
export const AUTHOR_URL = 'https://www.linkedin.com/in/dominic-g-6a9a5680/';
export const FORMATIX_URL = 'https://formatix.ai';

/** The finding this whole second source exists for, in one line. */
export const CONNECTIONS_LABEL = 'Also unfollow my connections (scans your followers list; slower)';
export const CONNECTIONS_HINT =
  'Connections are followed automatically and do not appear in LinkedIn’s Following list.';

export const FAST_LABEL = 'Fast (3 at a time — more likely to trip LinkedIn’s rate limit)';
export const FAST_HINT = 'Careful, one at a time, is the default and the one to use.';

/* ---- Quiet feed ---------------------------------------------------- */

export const QUIET_TITLE = 'Quiet feed';
export const QUIET_HINT =
  'Unfollowing empties the list you subscribed to; LinkedIn refills the feed with ' +
  'what your network liked, commented on and reposted. This hides those in the page.';
export const QUIET_MASTER_LABEL = 'Hide the posts you did not follow anyone to see';
export const QUIET_ACTIVITY_LABEL =
  'Network activity — likes, comments, reposts, “followed by”';
export const QUIET_SUGGESTED_HINT =
  'LinkedIn only draws a Follow button on a post when you do not follow its author, ' +
  'which is how the unlabelled suggestions are recognised.';
export const QUIET_PROMOTED_LABEL = 'Promoted (ads)';
export const QUIET_SUGGESTED_LABEL = 'Suggested and people you don’t follow';
export const QUIET_TOGETHER_LINE =
  'Together with Unfollow everyone, your feed shows only the people you choose to refollow.';

export const UNFOLLOW_WARNING =
  'Sends the same unfollow request the LinkedIn page sends, one person at a time, ' +
  'about one a second, from your own signed-in browser. There is no undo.';

/* ================================================================== */
/*  Talking to the service worker                                     */
/* ================================================================== */

/**
 * One round trip. The worker always answers `{ ok, data }` or `{ ok, error }`,
 * so a failure arrives as a thrown Error with a sentence in it.
 *
 * @param {string} type
 * @param {object} [params]
 * @returns {Promise<object>}
 */
export async function call(type, params = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...params });
  if (!response) {
    throw new Error('The extension did not answer. Reload it at chrome://extensions and retry.');
  }
  if (!response.ok) throw new Error(response.error || 'Something went wrong.');
  return response.data || {};
}

/* ================================================================== */
/*  Pieces                                                            */
/* ================================================================== */

const accounts = (n) => `${fmtNumber(n)} account${n === 1 ? '' : 's'}`;

/**
 * What the followers scan found, as a sentence — the number the Following list
 * does not show you.
 *
 * @param {{total: number|null, stillFollowing: number}} [followers]
 */
export function connectionsLine(followers) {
  if (!followers) return '';
  const still = Number(followers.stillFollowing) || 0;
  const total = followers.total === null ? NaN : Number(followers.total);
  const of = Number.isFinite(total) ? ` of your ${fmtNumber(total)} followers` : '';
  if (!still) return ` Nobody${of} is followed on top of that.`;
  return ` Another ${fmtNumber(still)}${of} — your connections — are followed too.`;
}

/** A plain list of names with a heading, or an empty state. */
export function nameList(names, heading) {
  if (!names.length) return empty('Nobody to unfollow.');
  return el(
    'div',
    { class: 'itemlist', 'data-testid': 'names' },
    el('p', { class: 'status' }, heading),
    el(
      'ul',
      { class: 'namelist' },
      names.map((name) => el('li', null, name)),
    ),
  );
}

/**
 * "Hidden today: 23 posts." — the only number quiet feed keeps.
 *
 * @param {number} n
 * @returns {string}
 */
export function hiddenTodayLine(n) {
  const count = Number(n) || 0;
  if (!count) return 'Nothing hidden yet today.';
  return `Hidden today: ${fmtNumber(count)} post${count === 1 ? '' : 's'}.`;
}

/**
 * The quiet feed card.
 *
 * Four tick boxes and a number. There is no button, because there is nothing to
 * run: the settings live in `chrome.storage.local`, the content script on the
 * feed is listening to that same storage, and a tick takes effect in an open
 * tab before you have let go of the mouse.
 *
 * @returns {{node: Node, load: () => Promise<void>, onHidden: (message: object) => void}}
 */
export function quietFeedCard() {
  const master = checkbox({ 'data-testid': 'quiet-enabled', checked: QUIET_FEED_DEFAULTS.enabled });
  const boxes = {
    activity: checkbox({
      'data-testid': 'quiet-activity',
      checked: QUIET_FEED_DEFAULTS.activity,
    }),
    promoted: checkbox({
      'data-testid': 'quiet-promoted',
      checked: QUIET_FEED_DEFAULTS.promoted,
    }),
    suggested: checkbox({
      'data-testid': 'quiet-suggested',
      checked: QUIET_FEED_DEFAULTS.suggested,
    }),
  };

  const count = el('p', { class: 'status', 'data-testid': 'quiet-count' }, hiddenTodayLine(0));

  /** With the master off, the three below it are inert; say so visually. */
  const paintEnabled = () => {
    for (const box of Object.values(boxes)) box.disabled = !master.checked;
  };

  const read = () => ({
    enabled: master.checked,
    activity: boxes.activity.checked,
    promoted: boxes.promoted.checked,
    suggested: boxes.suggested.checked,
  });

  const save = async () => {
    paintEnabled();
    await chrome.storage.local.set({ [QUIET_FEED_KEYS.SETTINGS]: read() });
  };

  for (const box of [master, ...Object.values(boxes)]) {
    box.addEventListener('change', () => {
      save().catch(() => {});
    });
  }

  /** Fill the boxes in from storage, and the number in from today's tally. */
  const load = async () => {
    const stored = await chrome.storage.local.get([
      QUIET_FEED_KEYS.SETTINGS,
      QUIET_FEED_KEYS.HIDDEN,
    ]);
    const settings = { ...QUIET_FEED_DEFAULTS, ...(stored[QUIET_FEED_KEYS.SETTINGS] || {}) };
    master.checked = settings.enabled !== false;
    for (const [key, box] of Object.entries(boxes)) box.checked = settings[key] !== false;
    paintEnabled();
    const today = (stored[QUIET_FEED_KEYS.HIDDEN] || {})[dayKey()] || {};
    count.textContent = hiddenTodayLine(today.total);
  };

  const node = card(
    QUIET_TITLE,
    { hint: QUIET_HINT, class: 'card--quiet' },
    checkField(QUIET_MASTER_LABEL, master),
    checkField(QUIET_ACTIVITY_LABEL, boxes.activity),
    checkField(QUIET_PROMOTED_LABEL, boxes.promoted),
    checkField(QUIET_SUGGESTED_LABEL, boxes.suggested, QUIET_SUGGESTED_HINT),
    count,
    el('p', { class: 'hint' }, QUIET_TOGETHER_LINE),
  );

  return {
    node,
    load,
    /** The content script's heartbeat, when the popup happens to be open. */
    onHidden: (message) => {
      count.textContent = hiddenTodayLine(message && message.total);
    },
  };
}

/**
 * Build the screen.
 *
 * @returns {{nodes: Node[], onProgress: (message: object) => void,
 *   quiet: {load: () => Promise<void>, onHidden: (message: object) => void}}}
 */
export function unfollowScreen() {
  const err = errorLine();
  const status = statusLine();
  const progress = el('p', { class: 'status', hidden: true, 'data-testid': 'progress' });
  const results = el('div', { 'data-testid': 'results' });

  const setProgress = (text) => {
    progress.textContent = text || '';
    progress.hidden = !text;
  };

  const limitInput = input({
    type: 'number',
    min: UNFOLLOW_LIMIT_MIN,
    max: UNFOLLOW_LIMIT_MAX,
    step: 1,
    value: String(UNFOLLOW_LIMIT_DEFAULT),
    placeholder: 'All',
    class: 'input input--num',
    'data-testid': 'limit',
    'aria-label': 'Unfollow up to how many accounts',
  });

  /** `null` means "no limit" — the box was left empty on purpose. */
  const readLimit = () => {
    const raw = String(limitInput.value == null ? '' : limitInput.value).trim();
    if (!raw) return null;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < UNFOLLOW_LIMIT_MIN) {
      throw new Error(
        `Enter ${UNFOLLOW_LIMIT_MIN} or more, or clear the box to work through everyone.`,
      );
    }
    if (n > UNFOLLOW_LIMIT_MAX) {
      throw new Error(`One run does at most ${fmtNumber(UNFOLLOW_LIMIT_MAX)}.`);
    }
    return n;
  };

  const everyoneBox = checkbox({ 'data-testid': 'everyone' });
  const fastBox = checkbox({ 'data-testid': 'fast' });

  /** Nothing is sent unless it was ticked, so an untouched popup behaves as before. */
  const scopeParams = () => (everyoneBox.checked ? { scope: SCOPE.EVERYONE } : {});

  const paramsFor = (extra) => {
    const limit = readLimit();
    return { ...(limit === null ? {} : { limit }), ...scopeParams(), ...extra };
  };

  /** Stop only exists while there is something to stop. */
  const stopBtn = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--ghost',
      'data-testid': 'stop',
      hidden: true,
      onclick: async () => {
        stopBtn.disabled = true;
        setProgress('Stopping after the person it is on…');
        await call(MESSAGES.STOP).catch(() => {});
      },
    },
    el('span', { class: 'btn-label' }, 'Stop'),
  );

  const showStop = (on) => {
    stopBtn.hidden = !on;
    stopBtn.disabled = false;
  };

  const countBtn = busyButton(
    'Check count',
    async () => {
      setProgress('');
      const everyone = everyoneBox.checked;
      if (everyone) status.set('Reading your followers list — this takes a couple of minutes…');
      try {
        const data = await call(MESSAGES.COUNT, scopeParams());
        const total = Number(data.count) || 0;
        const sample = Array.isArray(data.sample) ? data.sample : [];
        status.set(`You follow ${accounts(total)}.${connectionsLine(data.followers)}`);
        render(results, sample.length ? nameList(sample, 'First few:') : null);
      } finally {
        if (everyone) setProgress('');
      }
    },
    {
      variant: 'ghost',
      error: err,
      testid: 'count',
      ariaLabel: 'Check how many accounts you follow',
    },
  );

  const previewBtn = busyButton(
    'Preview',
    async () => {
      setProgress('');
      const params = paramsFor({});
      status.set(
        params.scope === SCOPE.EVERYONE
          ? 'Reading your following and followers lists — nothing is being unfollowed…'
          : 'Reading your following list — nothing is being unfollowed…',
      );
      try {
        const data = await call(MESSAGES.PREVIEW, params);
        const names = (Array.isArray(data.names) ? data.names : []).slice(0, UNFOLLOW_SAMPLE_MAX);
        status.set(
          names.length
            ? 'Preview only — nothing was unfollowed. These would be:'
            : 'Preview only — found nobody to unfollow.',
        );
        render(results, nameList(names, 'Would unfollow:'));
      } finally {
        setProgress('');
      }
    },
    {
      variant: 'ghost',
      error: err,
      testid: 'preview',
      ariaLabel: 'Preview who would be unfollowed, without unfollowing anyone',
    },
  );

  const unfollowBtn = busyButton(
    'Unfollow',
    async () => {
      const params = paramsFor(fastBox.checked ? { speed: SPEED.FAST } : {});
      const limit = params.limit === undefined ? null : params.limit;
      const target = limit === null ? 'everyone you follow' : accounts(limit);
      const alsoConnections =
        params.scope === SCOPE.EVERYONE
          ? ' Your connections are included, and they do not come back on their own: you stay ' +
            'connected, but anyone you want in your feed has to be followed again by hand.'
          : '';

      const sure = await confirmDialog({
        title: limit === null ? 'Unfollow everyone?' : `Unfollow up to ${fmtNumber(limit)}?`,
        message: `This will unfollow ${target}. It cannot be undone.${alsoConnections} ${UNFOLLOW_WARNING}`,
        confirmLabel: limit === null ? 'Unfollow all' : `Unfollow ${fmtNumber(limit)}`,
        danger: true,
      });
      if (!sure) {
        status.set('Cancelled — nothing was unfollowed.');
        return;
      }

      setProgress('Starting…');
      showStop(true);
      status.set(`Unfollowing ${target}…`);
      try {
        const data = await call(MESSAGES.UNFOLLOW, params);
        const done = Number(data.unfollowed) || 0;
        const names = Array.isArray(data.names) ? data.names : [];
        const tail =
          data.stopped === STOPPED.LIMIT
            ? ' Stopped at your limit.'
            : data.stopped === STOPPED.STOPPED
              ? ' You stopped it.'
              : data.error
                ? ` Stopped early: ${data.error}`
                : '';
        status.set(`Unfollowed ${accounts(done)}.${tail}`);
        render(results, nameList(names, 'Unfollowed:'));
      } catch (e) {
        status.clear();
        throw e;
      } finally {
        setProgress('');
        showStop(false);
      }
    },
    {
      variant: 'danger',
      error: err,
      testid: 'unfollow',
      ariaLabel: 'Unfollow the people you follow',
    },
  );

  const head = el(
    'header',
    { class: 'app-head' },
    el(
      'div',
      { class: 'app-title' },
      'LinkedIn Unfollow',
      el('small', null, 'One click. Human pace. Your browser.'),
    ),
  );

  const body = card(
    'Unfollow your feed',
    { hint: UNFOLLOW_WARNING },
    row(countBtn, previewBtn),
    field('Unfollow up to', limitInput, 'Leave empty to work through everyone.'),
    checkField(CONNECTIONS_LABEL, everyoneBox, CONNECTIONS_HINT),
    checkField(FAST_LABEL, fastBox, FAST_HINT),
    row(unfollowBtn, stopBtn),
    status,
    progress,
    err,
    results,
  );

  const foot = el(
    'footer',
    { class: 'app-foot' },
    el(
      'p',
      null,
      el(
        'a',
        { href: TOOLKIT_URL, target: '_blank', rel: 'noreferrer noopener' },
        'Want search export, lists, AI copilot? See LinkedIn Toolkit',
      ),
    ),
    el(
      'p',
      { class: 'credit' },
      'Built by ',
      el(
        'a',
        { href: AUTHOR_URL, target: '_blank', rel: 'noreferrer noopener' },
        'Dominic Gonsalves',
      ),
      ', founder of ',
      el('a', { href: FORMATIX_URL, target: '_blank', rel: 'noreferrer noopener' }, 'Formatix AI'),
      '.',
    ),
  );

  /**
   * The worker's heartbeat: every ten people while unfollowing, and every
   * followers page while scanning, if the popup is still open.
   */
  const onProgress = (message) => {
    if (message && message.phase === PHASE.SCANNING) {
      const scanned = Number(message.scanned) || 0;
      const outOf = message.followersTotal === null ? NaN : message.followersTotal;
      setProgress(`Scanning followers… ${fmtNumber(scanned)} of ${fmtNumber(outOf)}`);
      return;
    }
    const done = Number(message && message.unfollowed) || 0;
    const total = Number(message && message.total);
    const left = Number.isFinite(total) ? ` — about ${fmtNumber(Math.max(0, total))} to go` : '';
    setProgress(`Unfollowed ${fmtNumber(done)} so far${left}…`);
  };

  const quiet = quietFeedCard();

  return {
    nodes: [head, el('main', { class: 'view' }, quiet.node, body), foot],
    onProgress,
    quiet,
  };
}

/**
 * Draw the screen into `container` and listen for progress.
 * @param {HTMLElement} container
 */
export function mount(container) {
  const screen = unfollowScreen();
  render(container, screen.nodes);
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === MESSAGES.PROGRESS) screen.onProgress(message);
    if (message.type === MESSAGES.QUIET_FEED_HIDDEN) screen.quiet.onHidden(message);
  });
  // The boxes are drawn at their defaults and corrected from storage a tick
  // later, so the card is never blank and never wrong for long.
  screen.quiet.load().catch(() => {});
  return container;
}

/* The popup page itself. Absent in tests, which call `mount` directly. */
const root = typeof document === 'undefined' ? null : document.getElementById('app');
if (root) mount(root);
