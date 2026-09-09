/**
 * The handful of building blocks this one screen needs.
 *
 * Every button that talks to the service worker goes through `busyButton`, so
 * each one gets the same spinner, the same disabled-while-running behaviour and
 * the same inline error line.
 */

import { el, render } from './dom.js';

/* ================================================================== */
/*  Layout                                                            */
/* ================================================================== */

/** A titled card. */
export function card(title, opts, ...children) {
  const options = opts || {};
  return el(
    'section',
    { class: `card${options.class ? ` ${options.class}` : ''}` },
    title ? el('header', { class: 'card-head' }, el('h2', { class: 'card-title' }, title)) : null,
    options.hint ? el('p', { class: 'hint' }, options.hint) : null,
    el('div', { class: 'card-body' }, children),
  );
}

/** Label + control + optional hint. */
export function field(label, control, hint) {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'hint' }, hint) : null,
  );
}

/**
 * A checkbox with its label beside it, and an optional hint under both.
 *
 * The whole thing is one `<label>`, so the words are part of the hit area — a
 * 13px tick box on its own is not something to make somebody aim at.
 */
export function checkField(label, control, hint) {
  return el(
    'label',
    { class: 'check' },
    el('span', { class: 'check-row' }, control, el('span', { class: 'check-label' }, label)),
    hint ? el('span', { class: 'hint' }, hint) : null,
  );
}

/** Horizontal row of controls. */
export function row(...children) {
  return el('div', { class: 'row' }, children);
}

/* ================================================================== */
/*  Inputs                                                            */
/* ================================================================== */

export function input(attrs = {}) {
  return el('input', { type: 'text', class: 'input', ...attrs });
}

/** A tick box. Its own class, because `.input` is sized for typing in. */
export function checkbox(attrs = {}) {
  return el('input', { type: 'checkbox', class: 'checkbox', ...attrs });
}

/* ================================================================== */
/*  Errors, empty states, status                                      */
/* ================================================================== */

/** A hidden-until-needed inline error row with `.show(err)` / `.hide()`. */
export function errorLine() {
  const node = el('p', { class: 'err', hidden: true, 'data-testid': 'error' });
  node.show = (error) => {
    node.textContent = (error && error.message) || String(error || 'Something went wrong');
    node.hidden = false;
  };
  node.hide = () => {
    node.textContent = '';
    node.hidden = true;
  };
  return node;
}

/** A status line used for progress text. `.set(text)` / `.clear()`. */
export function statusLine(initial = '') {
  const node = el('p', { class: 'status', hidden: !initial, 'data-testid': 'status' }, initial);
  node.set = (text) => {
    node.textContent = text || '';
    node.hidden = !text;
  };
  node.clear = () => node.set('');
  return node;
}

export function empty(text) {
  return el('p', { class: 'empty' }, text);
}

export function spinner() {
  return el('span', { class: 'spinner', 'aria-hidden': 'true' });
}

/* ================================================================== */
/*  Buttons                                                           */
/* ================================================================== */

/**
 * A button that runs an async handler with a spinner, disables itself while
 * running and reports failures on an inline error line.
 *
 * @param {string} label
 * @param {() => Promise<*>} handler
 * @param {{ variant?: string, error?: object, ariaLabel?: string, testid?: string }} [opts]
 * @returns {HTMLButtonElement}
 */
export function busyButton(label, handler, opts = {}) {
  const variant = opts.variant || 'primary';
  const button = el('button', {
    type: 'button',
    class: `btn btn--${variant}`,
    'aria-label': opts.ariaLabel || null,
    'data-testid': opts.testid || null,
  });

  const paint = (busy) => {
    render(button, [busy ? spinner() : null, el('span', { class: 'btn-label' }, label)]);
  };
  paint(false);

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    if (opts.error) opts.error.hide();
    button.disabled = true;
    button.classList.add('is-busy');
    paint(true);
    try {
      await handler();
    } catch (e) {
      if (opts.error) opts.error.show(e);
      else console.error('[LinkedIn Unfollow]', e);
    } finally {
      button.disabled = false;
      button.classList.remove('is-busy');
      paint(false);
    }
  });

  return button;
}

/* ================================================================== */
/*  Confirmation dialog                                               */
/* ================================================================== */

/**
 * In-page confirmation. `window.confirm` is unavailable in some extension
 * surfaces and impossible to assert on, so this draws its own modal.
 *
 * @param {{ title: string, message: string, confirmLabel?: string,
 *           cancelLabel?: string, danger?: boolean, host?: HTMLElement }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts = {}) {
  const host = opts.host || document.body;
  return new Promise((resolve) => {
    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };

    const confirmBtn = el(
      'button',
      {
        type: 'button',
        class: `btn btn--${opts.danger ? 'danger' : 'primary'}`,
        'data-testid': 'confirm-ok',
        onclick: () => close(true),
      },
      opts.confirmLabel || 'Confirm',
    );

    const backdrop = el(
      'div',
      { class: 'modal-backdrop', 'data-testid': 'confirm-dialog' },
      el(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('h3', { class: 'modal-title' }, opts.title || 'Are you sure?'),
        opts.message ? el('p', { class: 'modal-body' }, opts.message) : null,
        el(
          'div',
          { class: 'modal-actions' },
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost',
              'data-testid': 'confirm-cancel',
              onclick: () => close(false),
            },
            opts.cancelLabel || 'Cancel',
          ),
          confirmBtn,
        ),
      ),
    );

    host.appendChild(backdrop);
    confirmBtn.focus();
  });
}
