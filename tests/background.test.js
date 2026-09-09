/**
 * The default engine: the two calls the LinkedIn page itself makes.
 *
 * Nothing here touches linkedin.com. `fetch` is answered by a small fake of the
 * Following endpoints that behaves the way the real ones do — the list shrinks
 * as people are unfollowed — so the tests can assert the exact URL, the exact
 * body, and, more importantly, everywhere the run is supposed to stop.
 *
 * Every person and every urn in the fixtures is invented.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  CONSECUTIVE_FAILURE_LIMIT,
  count,
  handleMessage,
  isRunning,
  nextDelayMs,
  requestStop,
  setSleepFn,
  unfollowAll,
} from '../src/background.js';
import {
  FOLLOWING_QUERY_ID,
  csrfToken,
  parseFollowingPage,
  unfollowUrl,
} from '../src/linkedin.js';
import { MESSAGES, PACING, STOPPED, UNFOLLOW_LIMIT_MAX } from '../src/constants.js';
import { PEOPLE, followingPage } from './fixtures/following-api.js';
import { dispatchMessage, jsonResponse, requests, serveFetch, signOut } from './setup.js';

/** The token the mock cookie jar yields, with LinkedIn's quotes taken off. */
const TOKEN = 'ajax:1234567890123456789';

const gets = () => requests().filter((r) => r.method === 'GET');
const posts = () => requests().filter((r) => r.method === 'POST');
const progressMessages = () =>
  chrome.__mock.messages.filter((m) => m.type === MESSAGES.PROGRESS);

/**
 * A fake of the two endpoints.
 *
 * @param {{people?: object[], listStatus?: number,
 *          unfollowStatus?: (urn: string, state: object) => number,
 *          afterUnfollow?: (state: object) => void}} [options]
 */
function fakeLinkedIn(options = {}) {
  const state = {
    people: [...(options.people || PEOPLE)],
    unfollowed: [],
  };

  serveFetch((request) => {
    if (request.method === 'GET') {
      if (options.listStatus && options.listStatus !== 200) {
        return jsonResponse(options.listStatus, {});
      }
      const start = Number(request.url.match(/start:(\d+)/)[1]);
      const size = Number(request.url.match(/count:(\d+)/)[1]);
      return jsonResponse(
        200,
        followingPage({ people: state.people, start, count: size, total: state.people.length }),
      );
    }

    const urn = request.url.split('urn:li:fsd_followingState:')[1];
    const status = options.unfollowStatus ? options.unfollowStatus(urn, state) : 200;
    if (status === 200) {
      state.unfollowed.push(urn);
      state.people = state.people.filter((person) => person.urn !== urn);
    }
    if (options.afterUnfollow) options.afterUnfollow(state);
    return jsonResponse(status, {});
  });

  return state;
}

/** Pacing is asserted on its own; no test waits out a real gap. */
let delays;
beforeEach(() => {
  delays = [];
  setSleepFn((ms) => {
    delays.push(ms);
    return Promise.resolve();
  });
});

/* ================================================================== */
/*  Signing in                                                        */
/* ================================================================== */

describe('csrfToken', () => {
  it('is the JSESSIONID cookie with its quotes taken off', async () => {
    expect(await csrfToken()).toBe(TOKEN);
  });

  it('says so, and asks for nothing, when you are not signed in', async () => {
    signOut();
    fakeLinkedIn();

    await expect(count()).rejects.toThrow(/not signed in to LinkedIn/i);
    expect(requests()).toHaveLength(0);
  });
});

/* ================================================================== */
/*  Reading the list                                                  */
/* ================================================================== */

describe('parseFollowingPage', () => {
  it('takes the total from the metadata, not from the rows returned', () => {
    const parsed = parseFollowingPage(followingPage({ start: 0, count: 10, total: 735 }));

    expect(parsed.total).toBe(735);
    expect(parsed.people).toHaveLength(10);
    expect(parsed.people[0]).toEqual({ name: PEOPLE[0].name, urn: PEOPLE[0].urn });
  });

  it('survives a payload with nothing it recognises in it', () => {
    expect(parseFollowingPage({})).toEqual({ total: null, people: [] });
    expect(parseFollowingPage(null)).toEqual({ total: null, people: [] });
  });

  it('does not list the same profile twice', () => {
    const twice = followingPage({ people: [PEOPLE[0], PEOPLE[0]], count: 2 });

    expect(parseFollowingPage(twice).people).toHaveLength(1);
  });
});

describe('count', () => {
  it('is one request, and reports LinkedIn’s own total', async () => {
    fakeLinkedIn();

    const result = await count();

    expect(result.count).toBe(PEOPLE.length);
    expect(result.sample).toEqual(PEOPLE.slice(0, 10).map((p) => p.name));
    expect(requests()).toHaveLength(1);
  });

  it('asks for exactly the captured list URL', async () => {
    fakeLinkedIn();

    await count();

    expect(gets()[0].url).toBe(
      'https://www.linkedin.com/voyager/api/graphql?variables=(start:0,count:10,' +
        'origin:CurationHub,query:(flagshipSearchIntent:MYNETWORK_CURATION_HUB,' +
        'includeFiltersInResponse:true,queryParameters:List((key:resultType,' +
        `value:List(PEOPLE_FOLLOW)))))&queryId=${FOLLOWING_QUERY_ID}`,
    );
    expect(gets()[0].headers['csrf-token']).toBe(TOKEN);
    expect(gets()[0].credentials).toBe('include');
  });

  it('turns a refusal into a sentence rather than a status code', async () => {
    fakeLinkedIn({ listStatus: 429 });

    await expect(count()).rejects.toThrow(/rate-limiting/i);
  });
});

/* ================================================================== */
/*  Unfollowing                                                       */
/* ================================================================== */

describe('unfollowAll', () => {
  it('POSTs exactly what was captured, for exactly the right person', async () => {
    fakeLinkedIn();

    await unfollowAll({ limit: 1 });

    expect(posts()).toHaveLength(1);
    const post = posts()[0];
    expect(post.url).toBe(
      'https://www.linkedin.com/voyager/api/feed/dash/followingStates/' +
        `urn:li:fsd_followingState:${PEOPLE[0].urn}`,
    );
    expect(post.url).toBe(unfollowUrl(PEOPLE[0].urn));
    expect(post.body).toBe('{"patch":{"$set":{"following":false}}}');
    expect(post.headers).toEqual({
      'csrf-token': TOKEN,
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'content-type': 'application/json; charset=UTF-8',
    });
  });

  it('stops after `limit` successful unfollows', async () => {
    const server = fakeLinkedIn();

    const result = await unfollowAll({ limit: 3 });

    expect(result.unfollowed).toBe(3);
    expect(result.attempted).toBe(3);
    expect(result.stopped).toBe(STOPPED.LIMIT);
    expect(result.names).toEqual(PEOPLE.slice(0, 3).map((p) => p.name));
    expect(server.unfollowed).toEqual(PEOPLE.slice(0, 3).map((p) => p.urn));
  });

  it('unfollows exactly one when asked for one — the run you try first', async () => {
    const server = fakeLinkedIn();

    const result = await unfollowAll({ limit: 1 });

    expect(result.unfollowed).toBe(1);
    expect(server.unfollowed).toEqual([PEOPLE[0].urn]);
    expect(server.people).toHaveLength(PEOPLE.length - 1);
  });

  it('pages past the first ten and gets through everyone', async () => {
    const server = fakeLinkedIn();

    const result = await unfollowAll({});

    expect(result.unfollowed).toBe(PEOPLE.length);
    expect(result.stopped).toBe(STOPPED.END);
    expect(server.people).toEqual([]);
    expect(posts()).toHaveLength(PEOPLE.length);
  });

  it('treats an empty limit as the ceiling, not as infinity', async () => {
    fakeLinkedIn({ people: [] });

    const result = await unfollowAll({});

    expect(UNFOLLOW_LIMIT_MAX).toBe(5000);
    expect(result.stopped).toBe(STOPPED.END);
    expect(posts()).toHaveLength(0);
  });

  it('paces itself at 0.8–1.6 seconds a person', async () => {
    fakeLinkedIn();

    await unfollowAll({ limit: 5 });

    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(PACING.minDelayMs);
      expect(delay).toBeLessThanOrEqual(PACING.maxDelayMs);
    }
    expect(nextDelayMs()).toBeGreaterThanOrEqual(800);
    expect(nextDelayMs()).toBeLessThanOrEqual(1600);
  });

  it('announces progress every ten, and once at the end', async () => {
    fakeLinkedIn();

    await unfollowAll({ limit: 20 });

    const seen = progressMessages().map((m) => m.unfollowed);
    expect(seen).toEqual([10, 20, 20]);
    expect(progressMessages()[0].total).toBeTypeOf('number');
  });
});

/* ================================================================== */
/*  Preview                                                           */
/* ================================================================== */

describe('unfollowAll — dry run', () => {
  it('reads the list and unfollows nobody', async () => {
    const server = fakeLinkedIn();

    const result = await unfollowAll({ limit: 5, dryRun: true });

    expect(result.names).toEqual(PEOPLE.slice(0, 5).map((p) => p.name));
    expect(result.unfollowed).toBe(0);
    expect(result.attempted).toBe(0);
    expect(posts()).toHaveLength(0);
    expect(server.unfollowed).toEqual([]);
  });

  it('pages forward through the whole list when there is no limit', async () => {
    fakeLinkedIn();

    const result = await unfollowAll({ dryRun: true });

    expect(result.names).toEqual(PEOPLE.map((p) => p.name));
    expect(posts()).toHaveLength(0);
  });

  it('never announces progress, because nothing happened', async () => {
    fakeLinkedIn();

    await unfollowAll({ limit: 5, dryRun: true });

    expect(progressMessages()).toEqual([]);
  });
});

/* ================================================================== */
/*  Everywhere it stops                                               */
/* ================================================================== */

describe('unfollowAll — stop conditions', () => {
  for (const [status, pattern] of [
    [429, /rate-limiting/i],
    [451, /451/],
    [401, /signed you out/i],
    [403, /refused the request/i],
  ]) {
    it(`stops dead on ${status}, keeping what it already did`, async () => {
      const server = fakeLinkedIn({
        unfollowStatus: (urn, state) => (state.unfollowed.length >= 2 ? status : 200),
      });

      const result = await unfollowAll({ limit: 25 });

      expect(result.unfollowed).toBe(2);
      expect(result.stopped).toBe(STOPPED.ERROR);
      expect(result.error).toMatch(pattern);
      expect(server.unfollowed).toHaveLength(2);
      // The refusal is the last request: nothing was retried after it.
      expect(posts()).toHaveLength(3);
    });
  }

  it('stops when the list call itself is refused', async () => {
    fakeLinkedIn({ listStatus: 451 });

    const result = await unfollowAll({ limit: 5 });

    expect(result.stopped).toBe(STOPPED.ERROR);
    expect(result.error).toMatch(/451/);
    expect(posts()).toHaveLength(0);
  });

  it('stops after two non-200s in a row', async () => {
    fakeLinkedIn({ unfollowStatus: () => 500 });

    const result = await unfollowAll({ limit: 25 });

    expect(CONSECUTIVE_FAILURE_LIMIT).toBe(2);
    expect(posts()).toHaveLength(2);
    expect(result.unfollowed).toBe(0);
    expect(result.attempted).toBe(2);
    expect(result.stopped).toBe(STOPPED.ERROR);
    expect(result.error).toMatch(/two requests in a row/i);
  });

  it('carries on after a single failure that then recovers', async () => {
    let calls = 0;
    fakeLinkedIn({
      unfollowStatus: () => {
        calls += 1;
        return calls === 1 ? 500 : 200;
      },
    });

    const result = await unfollowAll({ limit: 2 });

    expect(result.unfollowed).toBe(2);
    expect(result.attempted).toBe(3);
    expect(result.stopped).toBe(STOPPED.LIMIT);
  });

  it('stops when you press Stop, after the person it is on', async () => {
    const server = fakeLinkedIn({
      afterUnfollow: (state) => {
        if (state.unfollowed.length === 2) requestStop();
      },
    });

    const result = await unfollowAll({ limit: 25 });

    expect(result.unfollowed).toBe(2);
    expect(result.stopped).toBe(STOPPED.STOPPED);
    expect(server.unfollowed).toHaveLength(2);
    expect(isRunning()).toBe(false);
  });

  it('forgets a Stop once the run has ended, so the next run is not stillborn', async () => {
    let stopOnce = true;
    fakeLinkedIn({
      afterUnfollow: (state) => {
        if (stopOnce && state.unfollowed.length === 1) {
          stopOnce = false;
          requestStop();
        }
      },
    });

    const first = await unfollowAll({ limit: 25 });
    expect(first.stopped).toBe(STOPPED.STOPPED);
    expect(first.unfollowed).toBe(1);

    const second = await unfollowAll({ limit: 2 });
    expect(second.stopped).toBe(STOPPED.LIMIT);
    expect(second.unfollowed).toBe(2);
  });

  it('a Stop pressed while nothing is running does not poison the next run', async () => {
    fakeLinkedIn();
    expect(requestStop()).toEqual({ running: false });

    expect(await unfollowAll({ limit: 1 })).toMatchObject({
      unfollowed: 1,
      stopped: STOPPED.LIMIT,
    });
  });
});

/* ================================================================== */
/*  The message router                                                */
/* ================================================================== */

describe('handleMessage', () => {
  it('answers `count`', async () => {
    fakeLinkedIn();

    expect(await handleMessage({ type: MESSAGES.COUNT })).toMatchObject({
      count: PEOPLE.length,
    });
  });

  it('runs `preview` without unfollowing anyone', async () => {
    fakeLinkedIn();

    const result = await handleMessage({ type: MESSAGES.PREVIEW, limit: 3 });

    expect(result.names).toHaveLength(3);
    expect(posts()).toHaveLength(0);
  });

  it('runs `unfollow` for real, with the limit it was given', async () => {
    fakeLinkedIn();

    const result = await handleMessage({ type: MESSAGES.UNFOLLOW, limit: 2 });

    expect(result.unfollowed).toBe(2);
    expect(posts()).toHaveLength(2);
  });

  it('answers `stop` immediately', async () => {
    expect(await handleMessage({ type: MESSAGES.STOP })).toEqual({ running: false });
  });

  it('rejects anything else rather than quietly doing nothing', async () => {
    await expect(handleMessage({ type: 'delete-everything' })).rejects.toThrow(/Unknown message/);
  });

  it('routes `mode: dom` to the click-the-page fallback instead', async () => {
    fakeLinkedIn();
    chrome.__mock.tabs.set(1, {
      id: 1,
      active: true,
      url: 'https://www.linkedin.com/mynetwork/network-manager/people-follow/following/',
    });
    chrome.__mock.executeScriptResults = [
      [{ result: { count: 4, loaded: 4, total: 4, labels: [] } }],
    ];

    const result = await handleMessage({ type: MESSAGES.COUNT, mode: 'dom' });

    expect(result).toEqual({ count: 4, sample: [] });
    expect(chrome.scripting.executeScript).toHaveBeenCalled();
    expect(requests()).toHaveLength(0); // no API call at all
  });

  it('is wired to chrome.runtime.onMessage and answers in an envelope', async () => {
    fakeLinkedIn();

    const [reply] = await dispatchMessage({ type: MESSAGES.COUNT });

    expect(reply.ok).toBe(true);
    expect(reply.data.count).toBe(PEOPLE.length);
  });

  it('reports a failure as `{ ok: false }` with a sentence', async () => {
    const [reply] = await dispatchMessage({ type: 'nonsense' });

    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/Unknown message/);
  });

  it('never lets a progress message loop back into the router', async () => {
    const spy = vi.fn();
    const replies = await dispatchMessage({ type: MESSAGES.PROGRESS, unfollowed: 1 });

    expect(replies.every((reply) => reply === undefined)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
