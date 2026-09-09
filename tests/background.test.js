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
  nextFastDelayMs,
  requestStop,
  setSleepFn,
  unfollowAll,
} from '../src/background.js';
import {
  FOLLOWING_QUERY_ID,
  csrfToken,
  parseFollowersPage,
  parseFollowingPage,
  unfollowUrl,
} from '../src/linkedin.js';
import {
  FAST_PACING,
  FAST_STREAMS,
  MESSAGES,
  PACING,
  PHASE,
  SCAN_PACING,
  SCOPE,
  SPEED,
  STOPPED,
  UNFOLLOW_LIMIT_MAX,
} from '../src/constants.js';
import {
  FOLLOWERS,
  FOLLOWERS_STILL_FOLLOWING,
  PEOPLE,
  followersPage,
  followingPage,
  manyFollowers,
} from './fixtures/following-api.js';
import { dispatchMessage, jsonResponse, requests, serveFetch, signOut } from './setup.js';

/** The token the mock cookie jar yields, with LinkedIn's quotes taken off. */
const TOKEN = 'ajax:1234567890123456789';

const gets = () => requests().filter((r) => r.method === 'GET');
const posts = () => requests().filter((r) => r.method === 'POST');
const progressMessages = () =>
  chrome.__mock.messages.filter((m) => m.type === MESSAGES.PROGRESS);

/**
 * A fake of the three endpoints.
 *
 * The Following list shrinks as people are unfollowed, the way the real one
 * does. The followers list deliberately does *not*: it is served exactly as
 * captured, so anyone unfollowed through the Following list is still sitting on
 * it with `following: true` — which is what makes the run's seen set, rather
 * than LinkedIn's own bookkeeping, the thing under test.
 *
 * `postDelayMs` holds each unfollow open for a few milliseconds so `maxInFlight`
 * can say how many streams were really running at once.
 *
 * @param {{people?: object[], followers?: object[], listStatus?: number,
 *          followersStatus?: (start: number) => number, postDelayMs?: number,
 *          unfollowStatus?: (urn: string, state: object) => number,
 *          afterUnfollow?: (state: object) => void}} [options]
 */
function fakeLinkedIn(options = {}) {
  const state = {
    people: [...(options.people || PEOPLE)],
    followers: [...(options.followers || [])],
    unfollowed: [],
    inFlight: 0,
    maxInFlight: 0,
  };

  serveFetch(async (request) => {
    if (request.method === 'GET') {
      const start = Number(request.url.match(/start:(\d+)/)[1]);
      const size = Number(request.url.match(/count:(\d+)/)[1]);

      if (request.url.includes('List(FOLLOWERS)')) {
        const status = options.followersStatus ? options.followersStatus(start) : 200;
        if (status !== 200) return jsonResponse(status, {});
        return jsonResponse(
          200,
          followersPage({
            people: state.followers,
            start,
            count: size,
            total: state.followers.length,
          }),
        );
      }

      if (options.listStatus && options.listStatus !== 200) {
        return jsonResponse(options.listStatus, {});
      }
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

    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    if (options.postDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.postDelayMs));
    }
    state.inFlight -= 1;
    return jsonResponse(status, {});
  });

  return state;
}

/** The urns of everyone on the followers fixture you are still following. */
const stillFollowingUrns = FOLLOWERS_STILL_FOLLOWING.map((person) => person.urn);

const scanMessages = () =>
  chrome.__mock.messages.filter((m) => m.type === MESSAGES.PROGRESS && m.phase === PHASE.SCANNING);

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
/*  The followers list, where the connections are                     */
/* ================================================================== */

describe('parseFollowersPage', () => {
  it('gives every person their own following state', () => {
    const parsed = parseFollowersPage(followersPage({ total: 9479 }));

    expect(parsed.total).toBe(9479);
    expect(parsed.people).toHaveLength(FOLLOWERS.length);
    expect(parsed.people[0]).toEqual({
      urn: FOLLOWERS[0].urn,
      name: FOLLOWERS[0].name,
      following: true,
    });
    expect(parsed.people.filter((person) => person.following)).toHaveLength(
      FOLLOWERS_STILL_FOLLOWING.length,
    );
  });

  it('takes names from the view model, because the Profile rows have none', () => {
    const parsed = parseFollowersPage(followersPage({ people: FOLLOWERS.slice(0, 3) }));

    expect(parsed.people.map((person) => person.name)).toEqual(
      FOLLOWERS.slice(0, 3).map((person) => person.name),
    );
    expect(parsed.people.some((person) => person.name === 'Unknown')).toBe(false);
  });

  it('treats a row with no state of its own as not followed', () => {
    const page = followersPage({ people: FOLLOWERS.slice(0, 2) });
    page.included = page.included.filter((item) => !item.$type.includes('FollowingState'));

    expect(parseFollowersPage(page).people.every((person) => person.following === false)).toBe(true);
  });

  it('survives a payload with nothing it recognises in it', () => {
    expect(parseFollowersPage({})).toEqual({ total: null, people: [] });
    expect(parseFollowersPage(null)).toEqual({ total: null, people: [] });
  });
});

describe('count — everyone', () => {
  it('asks for exactly the captured followers URL, fifty at a time', async () => {
    fakeLinkedIn({ followers: FOLLOWERS });

    await count({ scope: SCOPE.EVERYONE });

    expect(gets()[1].url).toBe(
      'https://www.linkedin.com/voyager/api/graphql?variables=(start:0,count:50,' +
        'origin:CurationHub,query:(flagshipSearchIntent:MYNETWORK_CURATION_HUB,' +
        'includeFiltersInResponse:true,queryParameters:List((key:resultType,' +
        `value:List(FOLLOWERS)))))&queryId=${FOLLOWING_QUERY_ID}`,
    );
    expect(gets()[1].headers['csrf-token']).toBe(TOKEN);
  });

  it('scans the followers list and reports the connections hiding behind it', async () => {
    fakeLinkedIn({ followers: FOLLOWERS });

    const result = await count({ scope: SCOPE.EVERYONE });

    expect(result.count).toBe(PEOPLE.length);
    expect(result.followers).toEqual({
      total: FOLLOWERS.length,
      stillFollowing: FOLLOWERS_STILL_FOLLOWING.length,
    });
  });

  it('says how far the scan has got, page by page', async () => {
    fakeLinkedIn({ followers: manyFollowers(120) });

    await count({ scope: SCOPE.EVERYONE });

    expect(scanMessages().map((m) => m.scanned)).toEqual([50, 100, 120]);
    expect(scanMessages()[0].followersTotal).toBe(120);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(SCAN_PACING.minDelayMs);
      expect(delay).toBeLessThanOrEqual(SCAN_PACING.maxDelayMs);
    }
  });

  it('reads nothing extra when the scope is the Following list', async () => {
    fakeLinkedIn({ followers: FOLLOWERS });

    const result = await count();

    expect(result.followers).toBeUndefined();
    expect(requests()).toHaveLength(1);
  });

  it('turns a refusal mid-scan into a sentence', async () => {
    fakeLinkedIn({ followers: manyFollowers(120), followersStatus: (start) => (start ? 429 : 200) });

    await expect(count({ scope: SCOPE.EVERYONE })).rejects.toThrow(/rate-limiting/i);
  });
});

describe('unfollowAll — everyone', () => {
  it('works the Following list first, then the connections behind the followers list', async () => {
    const server = fakeLinkedIn({ people: PEOPLE.slice(0, 3), followers: FOLLOWERS });

    const result = await unfollowAll({ scope: SCOPE.EVERYONE });

    expect(result.unfollowed).toBe(3 + FOLLOWERS_STILL_FOLLOWING.length);
    expect(result.stopped).toBe(STOPPED.END);
    expect(server.unfollowed).toEqual([
      ...PEOPLE.slice(0, 3).map((person) => person.urn),
      ...stillFollowingUrns,
    ]);
  });

  it('leaves alone the followers it is not following', async () => {
    const server = fakeLinkedIn({ people: [], followers: FOLLOWERS });

    const result = await unfollowAll({ scope: SCOPE.EVERYONE });

    expect(result.unfollowed).toBe(FOLLOWERS_STILL_FOLLOWING.length);
    for (const person of FOLLOWERS.filter((f) => !f.following)) {
      expect(server.unfollowed).not.toContain(person.urn);
    }
  });

  it('unfollows somebody on both lists exactly once', async () => {
    const shared = { ...PEOPLE[0], following: true };
    const server = fakeLinkedIn({
      people: [PEOPLE[0], PEOPLE[1]],
      followers: [shared, FOLLOWERS[0]],
    });

    const result = await unfollowAll({ scope: SCOPE.EVERYONE });

    expect(result.unfollowed).toBe(3);
    expect(server.unfollowed.filter((urn) => urn === PEOPLE[0].urn)).toHaveLength(1);
    expect(server.unfollowed).toEqual([PEOPLE[0].urn, PEOPLE[1].urn, FOLLOWERS[0].urn]);
  });

  it('spends its limit across both sources, not once each', async () => {
    const server = fakeLinkedIn({ people: PEOPLE.slice(0, 2), followers: FOLLOWERS });

    const result = await unfollowAll({ limit: 5, scope: SCOPE.EVERYONE });

    expect(result.unfollowed).toBe(5);
    expect(result.stopped).toBe(STOPPED.LIMIT);
    expect(server.unfollowed).toHaveLength(5);
    expect(server.unfollowed.slice(0, 2)).toEqual(PEOPLE.slice(0, 2).map((p) => p.urn));
  });

  it('counts the connections it finds into the total it reports', async () => {
    fakeLinkedIn({ people: PEOPLE.slice(0, 2), followers: FOLLOWERS });

    // A preview removes nobody, so both sources are still there to be counted:
    // the Following list's own total, plus every connection the scan turned up.
    const result = await unfollowAll({ dryRun: true, scope: SCOPE.EVERYONE });

    expect(result.total).toBe(2 + FOLLOWERS_STILL_FOLLOWING.length);
    expect(scanMessages().at(-1).total).toBe(2 + FOLLOWERS_STILL_FOLLOWING.length);
  });

  it('stops mid-scan when you press Stop', async () => {
    const server = fakeLinkedIn({
      people: PEOPLE.slice(0, 2),
      followers: FOLLOWERS,
      afterUnfollow: (state) => {
        if (state.unfollowed.length === 4) requestStop();
      },
    });

    const result = await unfollowAll({ scope: SCOPE.EVERYONE });

    expect(result.stopped).toBe(STOPPED.STOPPED);
    expect(result.unfollowed).toBe(4);
    expect(server.unfollowed).toHaveLength(4);
    expect(isRunning()).toBe(false);
  });

  it('ends the run when LinkedIn rate-limits the scan itself', async () => {
    const server = fakeLinkedIn({
      people: [],
      followers: manyFollowers(120),
      followersStatus: (start) => (start >= 50 ? 429 : 200),
    });

    const result = await unfollowAll({ scope: SCOPE.EVERYONE });

    expect(result.stopped).toBe(STOPPED.ERROR);
    expect(result.error).toMatch(/rate-limiting/i);
    // The first page's connections were unfollowed and kept.
    expect(result.unfollowed).toBe(server.unfollowed.length);
    expect(result.unfollowed).toBeGreaterThan(0);
  });

  it('leaves the same gap between followers pages a count-only scan does', async () => {
    fakeLinkedIn({ people: [], followers: manyFollowers(120) });

    await unfollowAll({ scope: SCOPE.EVERYONE });

    // Unfollow gaps start at 800ms, so anything shorter is a read gap.
    const reads = delays.filter((delay) => delay < PACING.minDelayMs);
    expect(reads.length).toBeGreaterThan(0);
    for (const delay of reads) {
      expect(delay).toBeGreaterThanOrEqual(SCAN_PACING.minDelayMs);
      expect(delay).toBeLessThanOrEqual(SCAN_PACING.maxDelayMs);
    }
  });

  it('previews both sources, and sends nothing at all', async () => {
    const server = fakeLinkedIn({ people: PEOPLE.slice(0, 2), followers: FOLLOWERS });

    const result = await unfollowAll({ dryRun: true, scope: SCOPE.EVERYONE });

    expect(result.names).toEqual([
      ...PEOPLE.slice(0, 2).map((person) => person.name),
      ...FOLLOWERS_STILL_FOLLOWING.map((person) => person.name),
    ]);
    expect(posts()).toHaveLength(0);
    expect(server.unfollowed).toEqual([]);
  });

  it('stops a preview at the limit, wherever the names came from', async () => {
    fakeLinkedIn({ people: PEOPLE.slice(0, 2), followers: FOLLOWERS });

    const result = await unfollowAll({ limit: 4, dryRun: true, scope: SCOPE.EVERYONE });

    expect(result.names).toEqual([
      PEOPLE[0].name,
      PEOPLE[1].name,
      FOLLOWERS_STILL_FOLLOWING[0].name,
      FOLLOWERS_STILL_FOLLOWING[1].name,
    ]);
    expect(posts()).toHaveLength(0);
  });
});

/* ================================================================== */
/*  Fast: three streams over one list                                 */
/* ================================================================== */

describe('unfollowAll — fast', () => {
  it('really does run three at a time', async () => {
    const server = fakeLinkedIn({ postDelayMs: 5 });

    const result = await unfollowAll({ limit: 9, speed: SPEED.FAST });

    expect(FAST_STREAMS).toBe(3);
    expect(server.maxInFlight).toBe(3);
    expect(result.unfollowed).toBe(9);
  });

  it('careful, which is the default, sends one at a time', async () => {
    const server = fakeLinkedIn({ postDelayMs: 5 });

    await unfollowAll({ limit: 9 });

    expect(server.maxInFlight).toBe(1);
  });

  it('paces each stream at 0.5–0.9 seconds', async () => {
    fakeLinkedIn();

    await unfollowAll({ limit: 9, speed: SPEED.FAST });

    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(FAST_PACING.minDelayMs);
      expect(delay).toBeLessThanOrEqual(FAST_PACING.maxDelayMs);
    }
    expect(nextFastDelayMs()).toBeGreaterThanOrEqual(500);
    expect(nextFastDelayMs()).toBeLessThanOrEqual(900);
  });

  it('never goes past the limit, however many streams are going', async () => {
    const server = fakeLinkedIn({ postDelayMs: 2 });

    const result = await unfollowAll({ limit: 5, speed: SPEED.FAST });

    expect(result.unfollowed).toBe(5);
    expect(result.stopped).toBe(STOPPED.LIMIT);
    expect(posts()).toHaveLength(5);
    expect(server.unfollowed).toEqual(PEOPLE.slice(0, 5).map((person) => person.urn));
  });

  it('unfollows exactly one when asked for one, and does not end at nought', async () => {
    const server = fakeLinkedIn({ postDelayMs: 2 });

    const result = await unfollowAll({ limit: 1, speed: SPEED.FAST });

    // Two of the three streams are refused a slot before the third has sent
    // anything; neither of them gets to end the run.
    expect(result.unfollowed).toBe(1);
    expect(result.stopped).toBe(STOPPED.LIMIT);
    expect(posts()).toHaveLength(1);
    expect(server.unfollowed).toEqual([PEOPLE[0].urn]);
  });

  it('unfollows exactly two when asked for two', async () => {
    const server = fakeLinkedIn({ postDelayMs: 2 });

    const result = await unfollowAll({ limit: 2, speed: SPEED.FAST });

    expect(result.unfollowed).toBe(2);
    expect(result.stopped).toBe(STOPPED.LIMIT);
    expect(posts()).toHaveLength(2);
    expect(server.unfollowed).toEqual(PEOPLE.slice(0, 2).map((person) => person.urn));
  });

  it('a limit bigger than the list ends at the end of the list', async () => {
    const server = fakeLinkedIn({ people: PEOPLE.slice(0, 3), postDelayMs: 2 });

    const result = await unfollowAll({ limit: 5, speed: SPEED.FAST });

    expect(result.unfollowed).toBe(3);
    expect(result.stopped).toBe(STOPPED.END);
    expect(server.people).toEqual([]);
  });

  it('hands out every person exactly once across the streams', async () => {
    const server = fakeLinkedIn({ postDelayMs: 1 });

    const result = await unfollowAll({ speed: SPEED.FAST });

    expect(result.unfollowed).toBe(PEOPLE.length);
    expect(new Set(server.unfollowed).size).toBe(PEOPLE.length);
    expect(server.people).toEqual([]);
  });

  it('a 429 on one stream halts the other two', async () => {
    let sent = 0;
    const server = fakeLinkedIn({
      postDelayMs: 5,
      // The first of the three requests in flight is refused.
      unfollowStatus: () => (sent++ === 0 ? 429 : 200),
    });

    const result = await unfollowAll({ limit: 25, speed: SPEED.FAST });

    expect(result.stopped).toBe(STOPPED.ERROR);
    expect(result.error).toMatch(/rate-limiting/i);
    // The two beside it landed; nothing new was sent after the refusal.
    expect(result.unfollowed).toBe(2);
    expect(posts()).toHaveLength(FAST_STREAMS);
    expect(server.unfollowed).toHaveLength(2);
    expect(isRunning()).toBe(false);
  });

  it('is never used for a preview, which sends nothing anyway', async () => {
    const server = fakeLinkedIn({ postDelayMs: 5 });

    const result = await unfollowAll({ limit: 6, dryRun: true, speed: SPEED.FAST });

    expect(result.names).toHaveLength(6);
    expect(server.maxInFlight).toBe(0);
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

  it('passes `scope` through to all three', async () => {
    fakeLinkedIn({ people: PEOPLE.slice(0, 1), followers: FOLLOWERS });

    const counted = await handleMessage({ type: MESSAGES.COUNT, scope: SCOPE.EVERYONE });
    expect(counted.followers.stillFollowing).toBe(FOLLOWERS_STILL_FOLLOWING.length);

    const previewed = await handleMessage({ type: MESSAGES.PREVIEW, scope: SCOPE.EVERYONE });
    expect(previewed.names).toHaveLength(1 + FOLLOWERS_STILL_FOLLOWING.length);

    const run = await handleMessage({ type: MESSAGES.UNFOLLOW, scope: SCOPE.EVERYONE });
    expect(run.unfollowed).toBe(1 + FOLLOWERS_STILL_FOLLOWING.length);
  });

  it('passes `speed` through to `unfollow`', async () => {
    const server = fakeLinkedIn({ postDelayMs: 5 });

    await handleMessage({ type: MESSAGES.UNFOLLOW, limit: 6, speed: SPEED.FAST });

    expect(server.maxInFlight).toBe(3);
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
