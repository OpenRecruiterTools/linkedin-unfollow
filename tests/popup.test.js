/**
 * The popup.
 *
 * The screen is one function of the DOM, so these tests mount it into jsdom and
 * press its buttons. The service worker is replaced by a stub on
 * `chrome.runtime.sendMessage`, so what is under test is the thing that matters
 * in a popup: that "Unfollow" cannot happen without a confirmation, that Stop
 * is there while a run is going, and that what comes back is what gets drawn.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  MESSAGES,
  PHASE,
  QUIET_FEED_KEYS,
  SCOPE,
  SPEED,
  STOPPED,
  UNFOLLOW_LIMIT_DEFAULT,
  dayKey,
} from '../src/constants.js';
import {
  AUTHOR_URL,
  CONNECTIONS_HINT,
  CONNECTIONS_LABEL,
  FAST_LABEL,
  FORMATIX_URL,
  QUIET_ACTIVITY_LABEL,
  QUIET_MASTER_LABEL,
  QUIET_PROMOTED_LABEL,
  QUIET_SUGGESTED_LABEL,
  QUIET_TITLE,
  QUIET_TOGETHER_LINE,
  TOOLKIT_URL,
  hiddenTodayLine,
  mount,
} from '../src/popup/popup.js';

let container;

/** Replies keyed by message type; anything else is a failed envelope. */
function serveWorker(replies) {
  chrome.runtime.sendMessage = vi.fn(async (message) => {
    if (Object.prototype.hasOwnProperty.call(replies, message.type)) {
      const reply = replies[message.type];
      return typeof reply === 'function' ? reply(message) : { ok: true, data: reply };
    }
    return { ok: false, error: `Unknown message: ${message.type}` };
  });
  return chrome.runtime.sendMessage;
}

/** The dialog is appended to the body, not into the container, so ask both. */
const $ = (testid) => document.querySelector(`[data-testid="${testid}"]`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const press = async (testid) => {
  $(testid).click();
  await settle();
};
const namesShown = () =>
  Array.from(container.querySelectorAll('.namelist li')).map((li) => li.textContent);

beforeEach(() => {
  document.body.textContent = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

/* ================================================================== */
/*  The screen                                                        */
/* ================================================================== */

describe('the screen', () => {
  it('opens with the limit filled in, Stop hidden, and the toolkit link below', () => {
    serveWorker({});
    mount(container);

    expect($('limit').value).toBe(String(UNFOLLOW_LIMIT_DEFAULT));
    expect($('stop').hidden).toBe(true);
    const link = container.querySelector('.app-foot a');
    expect(link.getAttribute('href')).toBe(TOOLKIT_URL);
    expect(link.textContent).toMatch(/LinkedIn Toolkit/);
  });

  it('offers both tick boxes, off, and says what each one costs', () => {
    serveWorker({});
    mount(container);

    expect($('everyone').checked).toBe(false);
    expect($('fast').checked).toBe(false);
    expect(container.textContent).toContain(CONNECTIONS_LABEL);
    expect(container.textContent).toContain(CONNECTIONS_HINT);
    expect(container.textContent).toContain(FAST_LABEL);
  });

  it('credits its author in the footer', () => {
    serveWorker({});
    mount(container);

    const credit = container.querySelector('.app-foot .credit');
    expect(credit.textContent).toBe('Built by Dominic Gonsalves, founder of Formatix AI.');
    expect([...credit.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      AUTHOR_URL,
      FORMATIX_URL,
    ]);
  });
});

/* ================================================================== */
/*  Check count                                                       */
/* ================================================================== */

describe('Check count', () => {
  it('renders the number you follow and the first few names', async () => {
    serveWorker({
      [MESSAGES.COUNT]: { count: 735, sample: ['Marta Quintrell', 'Idris Fenwake'] },
    });
    mount(container);

    await press('count');

    expect($('status').textContent).toBe('You follow 735 accounts.');
    expect(namesShown()).toEqual(['Marta Quintrell', 'Idris Fenwake']);
  });

  it('shows a failure from the worker on the error line', async () => {
    serveWorker({
      [MESSAGES.COUNT]: () => ({ ok: false, error: 'You are not signed in to LinkedIn.' }),
    });
    mount(container);

    await press('count');

    expect($('error').hidden).toBe(false);
    expect($('error').textContent).toBe('You are not signed in to LinkedIn.');
  });
});

/* ================================================================== */
/*  The connections box                                               */
/* ================================================================== */

describe('Also unfollow my connections', () => {
  it('makes Check count scan the followers list, and says what it found', async () => {
    const send = serveWorker({
      [MESSAGES.COUNT]: {
        count: 735,
        sample: [],
        followers: { total: 940, stillFollowing: 120 },
      },
    });
    mount(container);

    $('everyone').click();
    await press('count');

    expect(send).toHaveBeenCalledWith({ type: MESSAGES.COUNT, scope: SCOPE.EVERYONE });
    expect($('status').textContent).toBe(
      'You follow 735 accounts. Another 120 of your 940 followers — your connections — are followed too.',
    );
  });

  it('leaves Check count alone when it is not ticked', async () => {
    const send = serveWorker({ [MESSAGES.COUNT]: { count: 735, sample: [] } });
    mount(container);

    await press('count');

    expect(send).toHaveBeenCalledWith({ type: MESSAGES.COUNT });
    expect($('status').textContent).toBe('You follow 735 accounts.');
  });

  it('asks Preview for both lists', async () => {
    const send = serveWorker({
      [MESSAGES.PREVIEW]: { unfollowed: 0, attempted: 0, names: [], stopped: STOPPED.END },
    });
    mount(container);

    $('everyone').click();
    await press('preview');

    expect(send).toHaveBeenCalledWith({
      type: MESSAGES.PREVIEW,
      limit: UNFOLLOW_LIMIT_DEFAULT,
      scope: SCOPE.EVERYONE,
    });
  });

  it('warns in the dialog that connections are in it, then runs with the scope', async () => {
    const send = serveWorker({
      [MESSAGES.UNFOLLOW]: { unfollowed: 1, attempted: 1, names: [], stopped: STOPPED.LIMIT },
    });
    mount(container);

    $('everyone').click();
    await press('unfollow');
    expect(document.querySelector('.modal-body').textContent).toMatch(/connections are included/i);
    await press('confirm-ok');

    expect(send).toHaveBeenCalledWith({
      type: MESSAGES.UNFOLLOW,
      limit: UNFOLLOW_LIMIT_DEFAULT,
      scope: SCOPE.EVERYONE,
    });
  });

  it('says so rather than "0" when LinkedIn did not give a total', () => {
    serveWorker({});
    mount(container);

    for (const listener of chrome.__mock.listeners.onMessage) {
      listener(
        { type: MESSAGES.PROGRESS, phase: PHASE.SCANNING, scanned: 50, followersTotal: null },
        {},
        () => {},
      );
    }

    expect($('progress').textContent).toBe('Scanning followers… 50 of —');
  });

  it('shows the scan as it goes', () => {
    serveWorker({});
    mount(container);

    for (const listener of chrome.__mock.listeners.onMessage) {
      listener(
        { type: MESSAGES.PROGRESS, phase: PHASE.SCANNING, scanned: 150, followersTotal: 947 },
        {},
        () => {},
      );
    }

    expect($('progress').hidden).toBe(false);
    expect($('progress').textContent).toBe('Scanning followers… 150 of 947');
  });
});

/* ================================================================== */
/*  The fast box                                                      */
/* ================================================================== */

describe('Fast', () => {
  it('goes to the run, and to nothing that only reads', async () => {
    const send = serveWorker({
      [MESSAGES.COUNT]: { count: 4, sample: [] },
      [MESSAGES.PREVIEW]: { unfollowed: 0, attempted: 0, names: [], stopped: STOPPED.END },
      [MESSAGES.UNFOLLOW]: { unfollowed: 2, attempted: 2, names: [], stopped: STOPPED.LIMIT },
    });
    mount(container);

    $('fast').click();
    await press('count');
    await press('preview');
    expect(send).toHaveBeenCalledWith({ type: MESSAGES.COUNT });
    expect(send).toHaveBeenCalledWith({
      type: MESSAGES.PREVIEW,
      limit: UNFOLLOW_LIMIT_DEFAULT,
    });

    await press('unfollow');
    await press('confirm-ok');

    expect(send).toHaveBeenCalledWith({
      type: MESSAGES.UNFOLLOW,
      limit: UNFOLLOW_LIMIT_DEFAULT,
      speed: SPEED.FAST,
    });
  });

  it('rides along with the connections box when both are ticked', async () => {
    const send = serveWorker({
      [MESSAGES.UNFOLLOW]: { unfollowed: 2, attempted: 2, names: [], stopped: STOPPED.LIMIT },
    });
    mount(container);

    $('everyone').click();
    $('fast').click();
    $('limit').value = '';
    await press('unfollow');
    await press('confirm-ok');

    expect(send).toHaveBeenCalledWith({
      type: MESSAGES.UNFOLLOW,
      scope: SCOPE.EVERYONE,
      speed: SPEED.FAST,
    });
  });
});

/* ================================================================== */
/*  Preview                                                           */
/* ================================================================== */

describe('Preview', () => {
  it('asks for a preview and lists the names, unfollowing nothing', async () => {
    const send = serveWorker({
      [MESSAGES.PREVIEW]: {
        unfollowed: 0,
        attempted: 0,
        names: ['Marta Quintrell'],
        stopped: STOPPED.END,
      },
    });
    mount(container);

    await press('preview');

    expect(send).toHaveBeenCalledWith({ type: MESSAGES.PREVIEW, limit: UNFOLLOW_LIMIT_DEFAULT });
    expect(namesShown()).toEqual(['Marta Quintrell']);
    expect($('status').textContent).toMatch(/nothing was unfollowed/i);
  });
});

/* ================================================================== */
/*  Unfollow                                                          */
/* ================================================================== */

describe('Unfollow', () => {
  it('does nothing until the dialog is confirmed', async () => {
    const send = serveWorker({
      [MESSAGES.UNFOLLOW]: { unfollowed: 25, attempted: 25, names: [], stopped: STOPPED.LIMIT },
    });
    mount(container);

    await press('unfollow');

    // The dialog is up and the worker has not been asked for anything.
    expect(document.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('says the number and that it cannot be undone', async () => {
    serveWorker({});
    mount(container);

    await press('unfollow');

    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    expect(dialog.querySelector('.modal-title').textContent).toBe('Unfollow up to 25?');
    expect(dialog.querySelector('.modal-body').textContent).toMatch(/cannot be undone/i);
  });

  it('cancelling leaves the account alone', async () => {
    const send = serveWorker({});
    mount(container);

    await press('unfollow');
    await press('confirm-cancel');

    expect(send).not.toHaveBeenCalled();
    expect($('status').textContent).toMatch(/cancelled/i);
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });

  it('confirming runs it and renders who went', async () => {
    const send = serveWorker({
      [MESSAGES.UNFOLLOW]: {
        unfollowed: 2,
        attempted: 2,
        names: ['Marta Quintrell', 'Idris Fenwake'],
        stopped: STOPPED.LIMIT,
      },
    });
    mount(container);

    await press('unfollow');
    await press('confirm-ok');

    expect(send).toHaveBeenCalledWith({ type: MESSAGES.UNFOLLOW, limit: UNFOLLOW_LIMIT_DEFAULT });
    expect($('status').textContent).toBe('Unfollowed 2 accounts. Stopped at your limit.');
    expect(namesShown()).toEqual(['Marta Quintrell', 'Idris Fenwake']);
  });

  it('reports a run LinkedIn interrupted, and what it managed first', async () => {
    serveWorker({
      [MESSAGES.UNFOLLOW]: {
        unfollowed: 3,
        attempted: 4,
        names: ['Marta Quintrell'],
        stopped: STOPPED.ERROR,
        error: 'LinkedIn is rate-limiting you — stopped there.',
      },
    });
    mount(container);

    await press('unfollow');
    await press('confirm-ok');

    expect($('status').textContent).toMatch(/Unfollowed 3 accounts\. Stopped early: LinkedIn/);
    expect(namesShown()).toEqual(['Marta Quintrell']);
  });

  it('an empty box means everyone, and the dialog says so', async () => {
    const send = serveWorker({
      [MESSAGES.UNFOLLOW]: { unfollowed: 0, attempted: 0, names: [], stopped: STOPPED.END },
    });
    mount(container);
    $('limit').value = '';

    await press('unfollow');
    expect(document.querySelector('.modal-title').textContent).toBe('Unfollow everyone?');
    await press('confirm-ok');

    expect(send).toHaveBeenCalledWith({ type: MESSAGES.UNFOLLOW });
  });

  it('refuses a limit of zero before it asks the worker anything', async () => {
    const send = serveWorker({});
    mount(container);
    $('limit').value = '0';

    await press('unfollow');

    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect($('error').textContent).toMatch(/Enter 1 or more/);
  });
});

/* ================================================================== */
/*  Stop                                                              */
/* ================================================================== */

describe('Stop', () => {
  /** A run that hangs until the test lets it finish. */
  function pendingRun() {
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    serveWorker({
      [MESSAGES.UNFOLLOW]: () => pending,
      [MESSAGES.STOP]: { running: true },
    });
    return (data) => finish({ ok: true, data });
  }

  it('appears while a run is going and goes away when it ends', async () => {
    const finish = pendingRun();
    mount(container);

    await press('unfollow');
    await press('confirm-ok');
    expect($('stop').hidden).toBe(false);

    finish({ unfollowed: 4, attempted: 4, names: [], stopped: STOPPED.STOPPED });
    await settle();

    expect($('stop').hidden).toBe(true);
    expect($('status').textContent).toBe('Unfollowed 4 accounts. You stopped it.');
  });

  it('tells the worker to stop, once', async () => {
    const finish = pendingRun();
    mount(container);

    await press('unfollow');
    await press('confirm-ok');
    await press('stop');

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGES.STOP });
    expect($('stop').disabled).toBe(true);
    expect($('progress').textContent).toMatch(/Stopping/);

    finish({ unfollowed: 2, attempted: 2, names: [], stopped: STOPPED.STOPPED });
    await settle();
  });
});

/* ================================================================== */
/*  Progress                                                          */
/* ================================================================== */

describe('progress', () => {
  it('shows the worker’s heartbeat while a run is going', () => {
    serveWorker({});
    mount(container);

    for (const listener of chrome.__mock.listeners.onMessage) {
      listener({ type: MESSAGES.PROGRESS, unfollowed: 20, attempted: 21, total: 715 }, {}, () => {});
    }

    expect($('progress').hidden).toBe(false);
    expect($('progress').textContent).toBe('Unfollowed 20 so far — about 715 to go…');
  });
});

/* ================================================================== */
/*  Quiet feed                                                        */
/* ================================================================== */

describe('the quiet feed card', () => {
  /** The three category boxes, in the order they are drawn. */
  const CATEGORY_BOXES = ['quiet-activity', 'quiet-promoted', 'quiet-suggested'];

  it('sits above the unfollow card, with everything on', async () => {
    serveWorker({});
    mount(container);
    await settle();

    const cards = [...container.querySelectorAll('.card .card-title')].map((h) => h.textContent);
    expect(cards[0]).toBe(QUIET_TITLE);
    expect(cards).toContain('Unfollow your feed');

    expect($('quiet-enabled').checked).toBe(true);
    for (const testid of CATEGORY_BOXES) expect($(testid).checked).toBe(true);
  });

  it('names the three things it hides, and what it is for', async () => {
    serveWorker({});
    mount(container);
    await settle();

    for (const label of [
      QUIET_MASTER_LABEL,
      QUIET_ACTIVITY_LABEL,
      QUIET_PROMOTED_LABEL,
      QUIET_SUGGESTED_LABEL,
      QUIET_TOGETHER_LINE,
    ]) {
      expect(container.textContent).toContain(label);
    }
  });

  it('writes a tick straight to storage, where the feed is listening', async () => {
    serveWorker({});
    mount(container);
    await settle();

    $('quiet-promoted').checked = false;
    $('quiet-promoted').dispatchEvent(new Event('change'));
    await settle();

    const stored = await chrome.storage.local.get(QUIET_FEED_KEYS.SETTINGS);
    expect(stored[QUIET_FEED_KEYS.SETTINGS]).toEqual({
      enabled: true,
      activity: true,
      promoted: false,
      suggested: true,
    });
  });

  it('turning the master off leaves the three below it inert', async () => {
    serveWorker({});
    mount(container);
    await settle();
    for (const testid of CATEGORY_BOXES) expect($(testid).disabled).toBe(false);

    $('quiet-enabled').checked = false;
    $('quiet-enabled').dispatchEvent(new Event('change'));
    await settle();

    for (const testid of CATEGORY_BOXES) expect($(testid).disabled).toBe(true);
    const stored = await chrome.storage.local.get(QUIET_FEED_KEYS.SETTINGS);
    expect(stored[QUIET_FEED_KEYS.SETTINGS].enabled).toBe(false);
    // Off is off, not forgotten: the categories keep what they were set to.
    expect(stored[QUIET_FEED_KEYS.SETTINGS].promoted).toBe(true);
  });

  it('opens showing what was already saved', async () => {
    serveWorker({});
    await chrome.storage.local.set({
      [QUIET_FEED_KEYS.SETTINGS]: {
        enabled: true,
        activity: false,
        promoted: true,
        suggested: false,
      },
    });

    mount(container);
    await settle();

    expect($('quiet-activity').checked).toBe(false);
    expect($('quiet-promoted').checked).toBe(true);
    expect($('quiet-suggested').checked).toBe(false);
  });

  it('shows today’s tally, and only today’s', async () => {
    serveWorker({});
    await chrome.storage.local.set({
      [QUIET_FEED_KEYS.HIDDEN]: {
        [dayKey()]: { total: 23, reaction: 18, promoted: 3, suggested: 2 },
        '2020-01-01': { total: 9999 },
      },
    });

    mount(container);
    await settle();

    expect($('quiet-count').textContent).toBe('Hidden today: 23 posts.');
  });

  it('starts at nothing, and counts in whole posts', () => {
    expect(hiddenTodayLine(0)).toBe('Nothing hidden yet today.');
    expect(hiddenTodayLine(1)).toBe('Hidden today: 1 post.');
    expect(hiddenTodayLine(1234)).toBe('Hidden today: 1,234 posts.');
  });

  it('keeps up with the feed while the popup is open', async () => {
    serveWorker({});
    mount(container);
    await settle();
    expect($('quiet-count').textContent).toBe('Nothing hidden yet today.');

    for (const listener of chrome.__mock.listeners.onMessage) {
      listener({ type: MESSAGES.QUIET_FEED_HIDDEN, day: dayKey(), total: 7 }, {}, () => {});
    }

    expect($('quiet-count').textContent).toBe('Hidden today: 7 posts.');
  });
});
