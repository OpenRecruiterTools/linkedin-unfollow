/**
 * Vitest setup — an in-memory `chrome` mock.
 *
 * The extension has no build step and no runtime dependencies, so tests load
 * the real service-worker and popup modules and give them a `globalThis.chrome`
 * that behaves like MV3's promise-based API. Everything is in memory: no
 * network, no browser, nothing to clean up but `resetChrome()`.
 */
import { beforeEach, vi } from 'vitest';

const MANIFEST = { version: '1.0.0', name: 'LinkedIn Unfollow', manifest_version: 3 };

/** Mutable backing state; also reachable from tests via `chrome.__mock`. */
const mock = {
  storage: new Map(),
  tabs: new Map(),
  cookies: new Map(),
  messages: [],
  /** Every `fetch` the code under test made: `{ url, method, headers, body }`. */
  requests: [],
  listeners: {
    onMessage: [],
  },
  /** Queue of results returned by successive `chrome.scripting.executeScript` calls. */
  executeScriptResults: [],
  /** Fallback result when the queue is empty. */
  executeScriptResult: [{ result: null }],
  executeScriptCalls: [],
  nextTabId: 1,
};

function settle(value, callback) {
  if (typeof callback === 'function') callback(value);
  return Promise.resolve(value);
}

/* ------------------------------------------------------------------ */
/*  chrome.storage.local                                              */
/* ------------------------------------------------------------------ */

function storageGet(keys, callback) {
  const out = {};
  if (keys === undefined || keys === null) {
    for (const [k, v] of mock.storage) out[k] = v;
  } else if (typeof keys === 'string') {
    if (mock.storage.has(keys)) out[keys] = mock.storage.get(keys);
  } else if (Array.isArray(keys)) {
    for (const k of keys) if (mock.storage.has(k)) out[k] = mock.storage.get(k);
  } else if (typeof keys === 'object') {
    for (const [k, fallback] of Object.entries(keys)) {
      out[k] = mock.storage.has(k) ? mock.storage.get(k) : fallback;
    }
  }
  return settle(structuredClone(out), callback);
}

function storageSet(items, callback) {
  for (const [k, v] of Object.entries(items || {})) mock.storage.set(k, structuredClone(v));
  return settle(undefined, callback);
}

/* ------------------------------------------------------------------ */
/*  The mock itself                                                   */
/* ------------------------------------------------------------------ */

function buildChrome() {
  return {
    __mock: mock,

    get runtime() {
      return runtime;
    },

    storage: {
      local: {
        get: vi.fn(storageGet),
        set: vi.fn(storageSet),
        remove: vi.fn((keys, callback) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) mock.storage.delete(k);
          return settle(undefined, callback);
        }),
        clear: vi.fn((callback) => {
          mock.storage.clear();
          return settle(undefined, callback);
        }),
      },
    },

    tabs: {
      create: vi.fn((props, callback) => {
        const tab = { id: mock.nextTabId++, active: true, ...props };
        mock.tabs.set(tab.id, tab);
        return settle(tab, callback);
      }),
      update: vi.fn((tabId, props, callback) => {
        const tab = { ...(mock.tabs.get(tabId) || { id: tabId }), ...props };
        mock.tabs.set(tabId, tab);
        return settle(tab, callback);
      }),
      remove: vi.fn((tabId, callback) => {
        for (const id of Array.isArray(tabId) ? tabId : [tabId]) mock.tabs.delete(id);
        return settle(undefined, callback);
      }),
      get: vi.fn((tabId, callback) => settle(mock.tabs.get(tabId), callback)),
      query: vi.fn((info, callback) => {
        let tabs = [...mock.tabs.values()];
        if (info && info.active !== undefined) {
          tabs = tabs.filter((t) => !!t.active === info.active);
        }
        return settle(tabs, callback);
      }),
    },

    cookies: {
      get: vi.fn((details, callback) => settle(mock.cookies.get(details.name) || null, callback)),
    },

    scripting: {
      executeScript: vi.fn((injection, callback) => {
        mock.executeScriptCalls.push(injection);
        const next = mock.executeScriptResults.length
          ? mock.executeScriptResults.shift()
          : mock.executeScriptResult;
        return settle(next, callback);
      }),
    },
  };
}

const runtime = {
  id: 'linkedin-unfollow-test',
  getManifest: vi.fn(() => ({ ...MANIFEST })),
  getURL: vi.fn((path) => `chrome-extension://linkedin-unfollow-test/${path}`),
  sendMessage: vi.fn((message, callback) => {
    mock.messages.push(message);
    return settle(undefined, callback);
  }),
  onMessage: {
    addListener: vi.fn((fn) => mock.listeners.onMessage.push(fn)),
    removeListener: vi.fn((fn) => {
      mock.listeners.onMessage = mock.listeners.onMessage.filter((f) => f !== fn);
    }),
  },
};

/**
 * Wipe all mock state (storage, tabs, recorded calls) but keep the registered
 * listeners, because the modules under test register those once at import time
 * and are not re-imported between tests.
 */
export function resetChrome() {
  mock.storage.clear();
  mock.tabs.clear();
  mock.cookies.clear();
  mock.messages.length = 0;
  mock.requests.length = 0;
  mock.executeScriptResults.length = 0;
  mock.executeScriptCalls.length = 0;
  mock.executeScriptResult = [{ result: null }];
  mock.nextTabId = 1;

  // Signed in, unless a test says otherwise. LinkedIn quotes the value; the
  // code under test is expected to strip those quotes off.
  mock.cookies.set('JSESSIONID', { name: 'JSESSIONID', value: '"ajax:1234567890123456789"' });

  globalThis.chrome = buildChrome();
  globalThis.fetch = vi.fn(async () => jsonResponse(200, {}));
  return globalThis.chrome;
}

/** The bit of a `Response` these modules actually use. */
export function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/**
 * Answer `fetch` with `handler(request)`, recording every call.
 *
 * @param {(request: {url: string, method: string, headers: object, body: string|undefined}) => object} handler
 */
export function serveFetch(handler) {
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const request = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
      credentials: init.credentials,
    };
    mock.requests.push(request);
    return handler(request);
  });
  return globalThis.fetch;
}

/** Every request made so far. */
export function requests() {
  return mock.requests;
}

/** Sign the test user out. */
export function signOut() {
  mock.cookies.delete('JSESSIONID');
}

/** Convenience for tests: seed one active tab. */
export function setActiveTab(url, props = {}) {
  const tab = { id: mock.nextTabId++, active: true, url, ...props };
  mock.tabs.set(tab.id, tab);
  return tab;
}

/** Deliver a message to every registered `onMessage` listener. */
export function dispatchMessage(message) {
  return Promise.all(
    mock.listeners.onMessage.map(
      (listener) =>
        new Promise((resolve) => {
          const kept = listener(message, { id: 'test' }, resolve);
          if (kept !== true) resolve(undefined);
        }),
    ),
  );
}

resetChrome();

beforeEach(() => {
  resetChrome();
});
