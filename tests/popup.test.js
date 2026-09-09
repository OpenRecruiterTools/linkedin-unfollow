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

import { MESSAGES, STOPPED, UNFOLLOW_LIMIT_DEFAULT } from '../src/constants.js';
import { AUTHOR_URL, FORMATIX_URL, TOOLKIT_URL, mount } from '../src/popup/popup.js';

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
