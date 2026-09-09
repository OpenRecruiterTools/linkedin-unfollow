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
 */

import {
  MESSAGES,
  STOPPED,
  UNFOLLOW_LIMIT_DEFAULT,
  UNFOLLOW_LIMIT_MAX,
  UNFOLLOW_LIMIT_MIN,
  UNFOLLOW_SAMPLE_MAX,
} from '../constants.js';
import { el, render, fmtNumber } from '../ui/dom.js';
import {
  busyButton,
  card,
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
 * Build the screen.
 *
 * @returns {{nodes: Node[], onProgress: (message: object) => void}}
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

  const paramsFor = (extra) => {
    const limit = readLimit();
    return limit === null ? { ...extra } : { limit, ...extra };
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
      const data = await call(MESSAGES.COUNT);
      const total = Number(data.count) || 0;
      const sample = Array.isArray(data.sample) ? data.sample : [];
      status.set(`You follow ${accounts(total)}.`);
      render(results, sample.length ? nameList(sample, 'First few:') : null);
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
      status.set('Reading your following list — nothing is being unfollowed…');
      const data = await call(MESSAGES.PREVIEW, params);
      const names = (Array.isArray(data.names) ? data.names : []).slice(0, UNFOLLOW_SAMPLE_MAX);
      status.set(
        names.length
          ? 'Preview only — nothing was unfollowed. These would be:'
          : 'Preview only — found nobody to unfollow.',
      );
      render(results, nameList(names, 'Would unfollow:'));
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
      const params = paramsFor({});
      const limit = params.limit === undefined ? null : params.limit;
      const target = limit === null ? 'everyone you follow' : accounts(limit);

      const sure = await confirmDialog({
        title: limit === null ? 'Unfollow everyone?' : `Unfollow up to ${fmtNumber(limit)}?`,
        message: `This will unfollow ${target}. It cannot be undone. ${UNFOLLOW_WARNING}`,
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

  /** The worker's heartbeat, every ten people, if the popup is still open. */
  const onProgress = (message) => {
    const done = Number(message && message.unfollowed) || 0;
    const total = Number(message && message.total);
    const left = Number.isFinite(total) ? ` — about ${fmtNumber(Math.max(0, total))} to go` : '';
    setProgress(`Unfollowed ${fmtNumber(done)} so far${left}…`);
  };

  return { nodes: [head, el('main', { class: 'view' }, body), foot], onProgress };
}

/**
 * Draw the screen into `container` and listen for progress.
 * @param {HTMLElement} container
 */
export function mount(container) {
  const screen = unfollowScreen();
  render(container, screen.nodes);
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === MESSAGES.PROGRESS) screen.onProgress(message);
  });
  return container;
}

/* The popup page itself. Absent in tests, which call `mount` directly. */
const root = typeof document === 'undefined' ? null : document.getElementById('app');
if (root) mount(root);
