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
