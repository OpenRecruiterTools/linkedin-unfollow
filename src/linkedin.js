/**
 * The two LinkedIn calls this extension makes, and nothing else.
 *
 * Both are the requests linkedin.com's own page makes when you use the
 * "Following" manager, replayed from the service worker with your own cookies.
 * Nothing is bypassed: no token is forged, no security measure is worked
 * around, and if you are not signed in they fail exactly as the page would.
 *
 * Captured live 2026-09-09:
 *
 *   list      GET  /voyager/api/graphql?variables=(start:<n>,count:10,
 *                  origin:CurationHub,query:(flagshipSearchIntent:
 *                  MYNETWORK_CURATION_HUB,…resultType…PEOPLE_FOLLOW))
 *                  &queryId=voyagerSearchDashClusters.e438ab99…
 *             → data.data.searchDashClustersByAll.metadata.totalResultCount
 *               plus EntityResultViewModel rows in `included`
 *
 *   followers GET  the same query with resultType FOLLOWERS and count:50
 *             → the same total, the same EntityResultViewModel rows, and one
 *               com.linkedin.voyager.dash.feed.FollowingState per result
 *               carrying `following: true|false`
 *
 *   unfollow  POST /voyager/api/feed/dash/followingStates/
 *                  urn:li:fsd_followingState:urn:li:fsd_profile:<id>
 *             body {"patch":{"$set":{"following":false}}}  → 200
 *
 * Why there is a followers call at all, verified on a real account on
 * 2026-09-09: **the Following list does not include your connections.** You are
 * made to follow everyone you connect with, and you go on following them after
 * the Following list has been emptied to zero — which is why a feed that should
 * be silent is still full of posts. The followers list is the only place that
 * state is visible: every row comes back with its own `FollowingState`, so
 * `following: true` on a follower is a connection you are still following.
 *
 * The URL is built by hand, unencoded parentheses and all, because that is
 * what was captured and Rest.li's query grammar is not URL-encoded here.
 */

export const API_BASE = 'https://www.linkedin.com/voyager/api';

/**
 * The hashed id of the "who am I following" query.
 *
 * LinkedIn rotates these. When the list call starts coming back empty, this is
 * the first thing to re-capture from the network tab of the Following page.
 */
export const FOLLOWING_QUERY_ID =
  'voyagerSearchDashClusters.e438ab99259203e9c1cd3f358e217282';

/** The page size the site itself uses. */
export const PAGE_SIZE = 10;

/**
 * The page size for the followers list.
 *
 * Fifty is what the endpoint will give you in one go, and the followers list is
 * the long one — 9,479 followers is 190 reads at fifty, and would be 948 at ten.
 */
export const FOLLOWERS_PAGE_SIZE = 50;

/** The one and only body we ever POST. */
export const UNFOLLOW_PATCH = { patch: { $set: { following: false } } };

/** Statuses that mean: stop now, and do not try again today. */
export const FATAL_STATUSES = Object.freeze([401, 403, 429, 451]);

/** Why each of them is fatal, in a sentence a person can act on. */
export const FATAL_REASONS = Object.freeze({
  401: 'LinkedIn signed you out — stopped there. Sign in again before retrying.',
  403: 'LinkedIn refused the request — stopped there. Open linkedin.com and check your account.',
  429: 'LinkedIn is rate-limiting you — stopped there. Leave it for today.',
  451: 'LinkedIn blocked the request (451) — stopped there. Leave it for today.',
});

/**
 * One page of the people you follow.
 *
 * @param {number} start row offset
 * @param {number} [count] page size
 * @returns {string}
 */
export function followingListUrl(start, count = PAGE_SIZE) {
  return (
    `${API_BASE}/graphql?variables=(start:${start},count:${count},origin:CurationHub,` +
    'query:(flagshipSearchIntent:MYNETWORK_CURATION_HUB,includeFiltersInResponse:true,' +
    'queryParameters:List((key:resultType,value:List(PEOPLE_FOLLOW)))))' +
    `&queryId=${FOLLOWING_QUERY_ID}`
  );
}

/**
 * One page of the people who follow *you*, which is where the state of your
 * connections is visible.
 *
 * The same query as `followingListUrl`, with `FOLLOWERS` in place of
 * `PEOPLE_FOLLOW` — same origin, same hashed query id, same grammar.
 *
 * @param {number} start row offset
 * @param {number} [count] page size
 * @returns {string}
 */
export function followersListUrl(start, count = FOLLOWERS_PAGE_SIZE) {
  return (
    `${API_BASE}/graphql?variables=(start:${start},count:${count},origin:CurationHub,` +
    'query:(flagshipSearchIntent:MYNETWORK_CURATION_HUB,includeFiltersInResponse:true,' +
    'queryParameters:List((key:resultType,value:List(FOLLOWERS)))))' +
    `&queryId=${FOLLOWING_QUERY_ID}`
  );
}

/**
 * The following-state resource for one profile.
 *
 * @param {string} profileUrn e.g. `urn:li:fsd_profile:ACoAA…`
 * @returns {string}
 */
export function unfollowUrl(profileUrn) {
  return `${API_BASE}/feed/dash/followingStates/urn:li:fsd_followingState:${profileUrn}`;
}

/**
 * The CSRF token LinkedIn expects, which is simply the JSESSIONID cookie with
 * its quotes taken off. Reading it needs the `cookies` permission; there is no
 * other way to obtain it, and no way to forge one.
 *
 * @returns {Promise<string>}
 */
export async function csrfToken() {
  const cookie = await chrome.cookies.get({
    url: 'https://www.linkedin.com',
    name: 'JSESSIONID',
  });
  const raw = (cookie && cookie.value) || '';
  const token = raw.replace(/"/g, '').trim();
  if (!token) {
    throw new Error('You are not signed in to LinkedIn in this browser. Sign in and try again.');
  }
  return token;
}

/** The headers the site sends on these calls. */
export function apiHeaders(token) {
  return {
    'csrf-token': token,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    accept: 'application/vnd.linkedin.normalized+json+2.1',
    'content-type': 'application/json; charset=UTF-8',
  };
}

/* ================================================================== */
/*  Reading the list                                                  */
/* ================================================================== */

/** Pull `urn:li:fsd_profile:<id>` out of whichever urn field carries it. */
function profileUrnOf(item) {
  for (const field of ['entityUrn', 'trackingUrn', 'targetUrn', 'objectUrn']) {
    const value = item && item[field];
    const match = typeof value === 'string' && value.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

/** The displayed name, which lives one `title.text` down. */
function nameOf(item) {
  const title = item && item.title;
  if (title && typeof title.text === 'string' && title.text.trim()) return title.text.trim();
  return 'Unknown';
}

/**
 * Turn one graphql response into a total and a list of people.
 *
 * Tolerant on purpose: LinkedIn moves these shapes around, and a parser that
 * throws on an unexpected key would take a working unfollow down with it.
 *
 * @param {object} payload parsed JSON body
 * @returns {{total: number|null, people: {urn: string, name: string}[]}}
 */
export function parseFollowingPage(payload) {
  const cluster =
    payload &&
    payload.data &&
    payload.data.data &&
    payload.data.data.searchDashClustersByAll;
  const metadata = (cluster && cluster.metadata) || {};
  const paging = (cluster && cluster.paging) || {};
  const rawTotal = metadata.totalResultCount ?? paging.total ?? null;
  const total = Number.isFinite(Number(rawTotal)) && rawTotal !== null ? Number(rawTotal) : null;

  const people = [];
  const seen = new Set();
  for (const item of (payload && payload.included) || []) {
    const type = String((item && item.$type) || '');
    if (!type.includes('EntityResultViewModel')) continue;
    const urn = profileUrnOf(item);
    if (!urn || seen.has(urn)) continue;
    seen.add(urn);
    people.push({ urn, name: nameOf(item) });
  }

  return { total, people };
}

/**
 * Fetch one page of the following list.
 *
 * @param {{start: number, count?: number, token: string}} options
 * @returns {Promise<{status: number, total: number|null,
 *   people: {urn: string, name: string}[]}>}
 */
export async function fetchFollowingPage({ start, count = PAGE_SIZE, token }) {
  const response = await fetch(followingListUrl(start, count), {
    method: 'GET',
    credentials: 'include',
    headers: apiHeaders(token),
  });
  if (!response.ok) return { status: response.status, total: null, people: [] };

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ...parseFollowingPage(payload) };
}

/**
 * Turn one FOLLOWERS response into a total and a list of people, each carrying
 * whether you are still following them.
 *
 * Two kinds of row have to be put back together, because neither is complete on
 * its own:
 *
 *   - `…search.EntityResultViewModel` — the profile urn and, on `title.text`,
 *     the name. Read by exactly the same helpers the Following list uses.
 *   - `…feed.FollowingState` — `entityUrn:
 *     "urn:li:fsd_followingState:urn:li:fsd_profile:<id>"` and
 *     `following: true|false`. The `…identity.profile.Profile` rows in this
 *     response carry a picture and an urn but no name, so names never come from
 *     them.
 *
 * A row with no state of its own is reported as `following: false`, so an
 * unrecognised shape can only ever mean "do not touch this person".
 *
 * @param {object} payload parsed JSON body
 * @returns {{total: number|null,
 *   people: {urn: string, name: string, following: boolean}[]}}
 */
export function parseFollowersPage(payload) {
  const included = (payload && payload.included) || [];

  /** profile urn → following, from the FollowingState rows. */
  const states = new Map();
  for (const item of included) {
    const type = String((item && item.$type) || '');
    if (!type.includes('FollowingState')) continue;
    const urn = profileUrnOf(item);
    if (!urn) continue;
    states.set(urn, item.following === true);
  }

  const rows = parseFollowingPage(payload);
  const people = rows.people.map((person) => ({
    ...person,
    following: states.get(person.urn) === true,
  }));

  return { total: rows.total, people };
}

/**
 * Fetch one page of the followers list.
 *
 * @param {{start: number, count?: number, token: string}} options
 * @returns {Promise<{status: number, total: number|null,
 *   people: {urn: string, name: string, following: boolean}[]}>}
 */
export async function fetchFollowersPage({ start, count = FOLLOWERS_PAGE_SIZE, token }) {
  const response = await fetch(followersListUrl(start, count), {
    method: 'GET',
    credentials: 'include',
    headers: apiHeaders(token),
  });
  if (!response.ok) return { status: response.status, total: null, people: [] };

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ...parseFollowersPage(payload) };
}

/* ================================================================== */
/*  Unfollowing one person                                            */
/* ================================================================== */

/**
 * Unfollow exactly one profile.
 *
 * @param {{urn: string, token: string}} options
 * @returns {Promise<{status: number, ok: boolean}>}
 */
export async function postUnfollow({ urn, token }) {
  const response = await fetch(unfollowUrl(urn), {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders(token),
    body: JSON.stringify(UNFOLLOW_PATCH),
  });
  return { status: response.status, ok: !!response.ok };
}
