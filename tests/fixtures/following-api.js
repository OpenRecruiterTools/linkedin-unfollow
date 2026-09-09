/**
 * A stand-in for LinkedIn's "who am I following" graphql response.
 *
 * Every person here is invented and every urn is nonsense: nothing in this file
 * corresponds to a real LinkedIn member, and nothing in the tests ever reaches
 * linkedin.com. The shape is what was captured on 2026-09-09:
 *
 *   data.data.searchDashClustersByAll.metadata.totalResultCount   — the total
 *   included[]  — EntityResultViewModel rows, one per person, carrying the
 *                 profile urn on `entityUrn`/`trackingUrn` and the name on
 *                 `title.text`
 *
 * The FOLLOWERS variant of the same query (`followersPage`) adds, per result,
 * a FollowingState row carrying `following: true|false` and a Profile row that
 * has a picture and an urn but deliberately *no* name — which is how the real
 * response comes back, and why names have to come from the view model.
 */

/** Thirty invented people. */
export const PEOPLE = [
  'Marta Quintrell',
  'Idris Fenwake',
  'Solveig Brannock',
  'Teo Marchetti-Vane',
  'Priya Halloway',
  'Casimir Ødegard',
  'Nell Sarabande',
  'Osric Tannenbaum',
  'Juno Fairweather',
  'Bertrand Okoye-Sallow',
  'Ingrid Vasquez-Holm',
  'Rafferty Blythe',
  'Anouk Delacroix-Penn',
  'Mikael Strandberg',
  'Delphine Rusk',
  'Yannick Obuya',
  'Cressida Marlowe',
  'Hendrik Vosloo',
  'Amara Bexley',
  'Lucien Fairhurst',
  'Sanne Roothaert',
  'Gideon Ferraro-Lark',
  'Tamsin Underhay',
  'Emeka Balogun-Reid',
  'Freya Lindqvist',
  'Rowan Petrossian',
  'Beatrix Ollenshaw',
  'Kwame Adjei-Stone',
  'Saoirse Brennagh',
  'Viggo Halbrand',
].map((name, index) => ({
  name,
  urn: `urn:li:fsd_profile:ACoAATESTFIXTURE${String(index + 1).padStart(4, '0')}`,
}));

/** One `included` row, shaped like the real EntityResultViewModel. */
function entityResult(person) {
  return {
    $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
    entityUrn: `urn:li:fsd_entityResultViewModel:(${person.urn},SEARCH,DEFAULT)`,
    trackingUrn: person.urn,
    title: { text: person.name, $type: 'com.linkedin.voyager.dash.common.text.TextViewModel' },
    primarySubtitle: { text: 'Invented job at Invented Company' },
  };
}

/**
 * A response for `start` / `count`, out of `people`.
 *
 * @param {{start?: number, count?: number, total?: number,
 *          people?: {name: string, urn: string}[]}} [options]
 */
export function followingPage(options = {}) {
  const people = options.people || PEOPLE;
  const start = options.start === undefined ? 0 : options.start;
  const count = options.count === undefined ? 10 : options.count;
  const total = options.total === undefined ? people.length : options.total;
  const slice = people.slice(start, start + count);

  return {
    data: {
      data: {
        searchDashClustersByAll: {
          metadata: { totalResultCount: total },
          paging: { start, count, total },
          elements: [],
        },
      },
    },
    included: slice.map(entityResult),
  };
}

/** A response with no rows at all — the end of the list. */
export function emptyPage(total = 0) {
  return followingPage({ people: [], total });
}

/* ================================================================== */
/*  The followers list                                                */
/* ================================================================== */

/**
 * Twelve invented followers, some of whom you are still following.
 *
 * The `following: true` ones are the point: on a real account they are your
 * connections, followed automatically when you connected and invisible on the
 * Following list.
 */
export const FOLLOWERS = [
  ['Ottoline Vasquez-Reed', true],
  ['Bartholomew Ngata', false],
  ['Sunniva Kaltenbrunner', true],
  ['Elio Fairbrother-Nash', true],
  ['Marguerite Osei-Bonsu', false],
  ['Thaddeus Lindqvist-Roe', true],
  ['Perpetua Wrenfield', false],
  ['Kazimierz Oyelaran', true],
  ['Sybilla Trenchard-Moss', true],
  ['Ferdinand Achterberg', false],
  ['Hyacinth Baumgartner', true],
  ['Lorcan Petrosyan-Webb', true],
].map(([name, following], index) => ({
  name,
  following,
  urn: `urn:li:fsd_profile:ACoAAFOLLOWERFIX${String(index + 1).padStart(4, '0')}`,
}));

/** Everyone on the followers list you have not already unfollowed. */
export const FOLLOWERS_STILL_FOLLOWING = FOLLOWERS.filter((person) => person.following);

/** The following-state row: the only place `following` appears. */
function followingState(person) {
  return {
    $type: 'com.linkedin.voyager.dash.feed.FollowingState',
    entityUrn: `urn:li:fsd_followingState:${person.urn}`,
    following: person.following,
    followerCount: 100 + person.name.length,
  };
}

/** The profile row, which in this response carries a picture and no name. */
function profile(person) {
  return {
    $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
    entityUrn: person.urn,
    profilePicture: { displayImageUrn: 'urn:li:fsd_image:INVENTED' },
  };
}

/**
 * A FOLLOWERS response for `start` / `count`, out of `people`.
 *
 * @param {{start?: number, count?: number, total?: number,
 *          people?: {name: string, urn: string, following: boolean}[]}} [options]
 */
export function followersPage(options = {}) {
  const people = options.people || FOLLOWERS;
  const start = options.start === undefined ? 0 : options.start;
  const count = options.count === undefined ? 50 : options.count;
  const total = options.total === undefined ? people.length : options.total;
  const slice = people.slice(start, start + count);

  const page = followingPage({ people: slice, start: 0, count: slice.length, total });
  page.included = [
    ...slice.map(profile),
    ...page.included,
    ...slice.map(followingState),
  ];
  return page;
}

/**
 * As many invented followers as a test needs, for the pages the twelve above
 * cannot fill. Every third one you have already unfollowed.
 *
 * @param {number} howMany
 */
export function manyFollowers(howMany) {
  return Array.from({ length: howMany }, (_, index) => ({
    name: `Invented Follower ${index + 1}`,
    urn: `urn:li:fsd_profile:ACoAAFOLLOWERBULK${String(index + 1).padStart(4, '0')}`,
    following: index % 3 !== 0,
  }));
}
