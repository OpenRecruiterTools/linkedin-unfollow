/**
 * The classifier.
 *
 * Every string here is invented. No real person, post or company appears in
 * this file — the shapes are taken from what the feed looks like once the
 * Following list is empty, and the names are made up.
 *
 * The tests come in two halves, and the second half is the important one. The
 * first checks that each header form is recognised. The second checks the
 * things that would make this feature worse than useless: a person called
 * "Loves Dale", the word "Promoted" inside somebody's post, "3 comments" under
 * one, the draft box, the "Start a post" card. Hiding any of those is a bug of
 * a different order from failing to hide an ad.
 */
import { describe, it, expect } from 'vitest';

import { QUIET_CATEGORY } from '../src/constants.js';
import {
  GROUP_NAME_MAX,
  authorBlockIndex,
  classifyPost,
  extractHeader,
  lines,
} from '../src/content/classify.js';

/**
 * A post as `innerText` gives it: screen-reader prefix, optional header, author
 * block, then the post.
 *
 * @param {{header?: string|null, author?: string, degree?: string,
 *   headline?: string, body?: string, prefix?: boolean, inline?: boolean,
 *   twice?: boolean}} opts
 */
function post(opts = {}) {
  const {
    header = null,
    author = 'Marcus Webb',
    degree = '• 2nd',
    headline = 'Head of Data at Northwind',
    body = 'A thought about the thing.\n\n12 reactions · 3 comments',
    prefix = true,
    inline = false,
    twice = false,
  } = opts;

  const rows = [];
  if (prefix) rows.push('Feed post');
  if (header) rows.push(header);
  if (inline) {
    rows.push(`${author} ${degree}`);
  } else {
    rows.push(author);
    if (twice) rows.push(author);
    rows.push(degree);
  }
  rows.push(headline, '3h •', body);
  return rows.join('\n');
}

/* ================================================================== */
/*  Every header form                                                 */
/* ================================================================== */

describe('the headers LinkedIn puts above other people’s posts', () => {
  const reactions = [
    'Priya Raman likes this',
    'Priya Raman celebrates this',
    'Priya Raman loves this',
    'Priya Raman supports this',
    'Priya Raman finds this insightful',
    'Priya Raman finds this funny',
    'Priya Raman and 3 others like this',
    'Priya Raman and 12 others celebrate this',
  ];
  for (const header of reactions) {
    it(`reads "${header}" as a reaction`, () => {
      expect(classifyPost(post({ header }))).toBe(QUIET_CATEGORY.REACTION);
      expect(extractHeader(post({ header }))).toBe(header);
    });
  }

  const comments = [
    'Priya Raman commented',
    'Priya Raman commented on this',
    'Priya Raman and 3 others commented',
    'Priya Raman replied to this',
  ];
  for (const header of comments) {
    it(`reads "${header}" as a comment`, () => {
      expect(classifyPost(post({ header }))).toBe(QUIET_CATEGORY.COMMENT);
    });
  }

  it('reads a repost', () => {
    expect(classifyPost(post({ header: 'Priya Raman reposted this' }))).toBe(QUIET_CATEGORY.REPOST);
  });

  it('reads "Followed by <Name>" — somebody a connection follows', () => {
    expect(classifyPost(post({ header: 'Followed by Priya Raman' }))).toBe(
      QUIET_CATEGORY.FOLLOWED_BY,
    );
  });

  it('reads a suggestion', () => {
    expect(classifyPost(post({ header: 'Suggested' }))).toBe(QUIET_CATEGORY.SUGGESTED);
  });

  // "Suggested for you" is a module's own name, so it is read as one wherever it
  // appears. Both categories sit under the same tick box, so nothing changes for
  // a reader — only which number the banner puts it in.
  it('reads "Suggested for you" as the module heading it is', () => {
    expect(classifyPost(post({ header: 'Suggested for you' }))).toBe(
      QUIET_CATEGORY.RECOMMENDATION,
    );
  });

  it('reads an ad', () => {
    expect(
      classifyPost(post({ header: 'Promoted', author: 'Northwind Analytics', degree: '• Following' })),
    ).toBe(QUIET_CATEGORY.PROMOTED);
  });

  const other = [
    'Priya Raman was mentioned in this post',
    'Northwind Analytics is hiring',
    'Northwind Analytics posted a job',
    'Priya Raman shared this',
    'Priya Raman is attending Data Summit 2026',
    'Priya Raman follows Northwind Analytics',
  ];
  for (const header of other) {
    it(`reads "${header}" as other activity`, () => {
      expect(classifyPost(post({ header }))).toBe(QUIET_CATEGORY.OTHER_ACTIVITY);
    });
  }

  it('reads a post from somebody you actually follow as direct', () => {
    expect(classifyPost(post())).toBe(QUIET_CATEGORY.DIRECT);
    expect(extractHeader(post())).toBe(null);
  });

  it('reads a page you follow as direct', () => {
    expect(classifyPost(post({ author: 'Northwind Analytics', degree: '• Following' }))).toBe(
      QUIET_CATEGORY.DIRECT,
    );
  });

  it('reads every degree marker as an author block', () => {
    for (const degree of ['• 1st', '• 2nd', '• 3rd', '• 3rd+', '• Following']) {
      expect(classifyPost(post({ degree }))).toBe(QUIET_CATEGORY.DIRECT);
      expect(classifyPost(post({ degree, header: 'Priya Raman likes this' }))).toBe(
        QUIET_CATEGORY.REACTION,
      );
    }
  });
});

/* ================================================================== */
/*  Layout                                                            */
/* ================================================================== */

describe('the shapes innerText comes in', () => {
  it('works with the "Feed post" prefix and without it', () => {
    expect(classifyPost(post({ header: 'Priya Raman likes this', prefix: false }))).toBe(
      QUIET_CATEGORY.REACTION,
    );
    expect(classifyPost(post({ prefix: false }))).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('strips a numbered prefix too', () => {
    const text = ['Feed post number 4', 'Priya Raman likes this', 'Marcus Webb', '• 2nd'].join('\n');
    expect(lines(text)[0]).toBe('Priya Raman likes this');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.REACTION);
  });

  it('works when the name and the degree share a line', () => {
    expect(classifyPost(post({ inline: true }))).toBe(QUIET_CATEGORY.DIRECT);
    expect(classifyPost(post({ inline: true, header: 'Priya Raman reposted this' }))).toBe(
      QUIET_CATEGORY.REPOST,
    );
  });

  it('works when LinkedIn prints the author’s name twice', () => {
    expect(classifyPost(post({ twice: true }))).toBe(QUIET_CATEGORY.DIRECT);
    expect(classifyPost(post({ twice: true, header: 'Priya Raman commented' }))).toBe(
      QUIET_CATEGORY.COMMENT,
    );
  });

  it('finds the author block, or says there is none', () => {
    expect(authorBlockIndex(lines(post()))).toBe(1);
    expect(authorBlockIndex(lines('Start a post\nShare a photo'))).toBe(-1);
  });

  it('ignores blank lines and runs of spaces', () => {
    const text = '\n Feed post \n\n  Priya Raman   likes this  \n\nMarcus Webb\n• 2nd\n\n';
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.REACTION);
  });

  it('is unbothered by nothing at all', () => {
    for (const nothing of ['', '   ', null, undefined]) {
      expect(classifyPost(nothing)).toBe(QUIET_CATEGORY.UNKNOWN);
      expect(extractHeader(nothing)).toBe(null);
    }
  });
});

/* ================================================================== */
/*  The things it must not hide                                       */
/* ================================================================== */

describe('what it refuses to touch', () => {
  it('does not read a person called "Loves Dale" as a reaction', () => {
    expect(classifyPost(post({ author: 'Loves Dale' }))).toBe(QUIET_CATEGORY.DIRECT);
    expect(classifyPost(post({ author: 'Loves Dale', twice: true }))).toBe(QUIET_CATEGORY.DIRECT);
    expect(classifyPost(post({ author: 'Loves Dale', inline: true }))).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('still classifies a post by "Loves Dale" that somebody liked', () => {
    expect(classifyPost(post({ author: 'Loves Dale', header: 'Priya Raman likes this' }))).toBe(
      QUIET_CATEGORY.REACTION,
    );
  });

  it('does not read a company called "Everyone Loves This" as a reaction', () => {
    const text = post({ author: 'Everyone Loves This', degree: '• Following', twice: true });
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('does not read "Promoted" in the middle of a post as an ad', () => {
    const text = post({ body: 'We just Promoted three people. Promoted, not hired.' });
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
    expect(extractHeader(text)).toBe(null);
  });

  it('does not read "Suggested" in the middle of a post as a suggestion', () => {
    expect(classifyPost(post({ body: 'Suggested reading for the weekend:' }))).toBe(
      QUIET_CATEGORY.DIRECT,
    );
  });

  it('does not read "3 comments" under a post as somebody having commented', () => {
    const text = post({ body: 'A thought.\n41 reactions · 3 comments · 2 reposts' });
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('does not read a headline containing "is hiring" as an activity header', () => {
    expect(classifyPost(post({ headline: 'Northwind is hiring — DM me' }))).toBe(
      QUIET_CATEGORY.DIRECT,
    );
  });

  it('leaves the draft box alone', () => {
    expect(classifyPost('Draft: the thing I never posted\nSaved 2d ago')).toBe(
      QUIET_CATEGORY.UNKNOWN,
    );
    expect(classifyPost('Draft')).toBe(QUIET_CATEGORY.UNKNOWN);
  });

  it('leaves the "Start a post" card alone', () => {
    expect(classifyPost('Start a post\nVideo\nPhoto\nWrite article')).toBe(QUIET_CATEGORY.UNKNOWN);
  });

  it('leaves any list item without an author block alone', () => {
    const items = [
      'Show more feed updates',
      'Sort by: Top\nRecent',
      'Priya Raman likes this', // a header and nothing under it is not a post
    ];
    for (const text of items) expect(classifyPost(text)).toBe(QUIET_CATEGORY.UNKNOWN);
  });

  it('shows, rather than hides, a header form nobody has taught it', () => {
    const text = post({ header: 'Priya Raman has a new profile photo' });
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
    expect(extractHeader(text)).toBe(null);
  });
});

/* ================================================================== */
/*  The live feed                                                     */
/* ================================================================== */

/**
 * Five layouts taken off the real home feed after unfollowing everyone, with
 * the names replaced. The first three were misses on the first pass, and each
 * one is a different reason "a header above the author" was not enough: a page
 * has no degree marker, "Promoted" sits *below* a page's name rather than above
 * it, and the largest category of all carries no header whatsoever.
 */
describe('layouts observed on the live feed', () => {
  it('reads a promoted page post — no degree marker, "Promoted" below the name', () => {
    const text = [
      'Feed post',
      'The Agency Blueprint',
      '10,927 followers',
      'Promoted',
      'If I lost my agency tomorrow, here is what I would do first…',
    ].join('\n');

    expect(classifyPost(text)).toBe(QUIET_CATEGORY.PROMOTED);
  });

  it('counts a follower line as an author block whatever shape the number is', () => {
    const shapes = ['10,927 followers', '248,166 followers', '12K followers', '1.4M followers'];
    for (const followers of shapes) {
      const text = ['Feed post', 'Vellum Ltd', followers, 'A thought.'].join('\n');
      expect(authorBlockIndex(lines(text))).toBe(1);
      expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
    }
  });

  it('reads "<Name> follows this page" over a promoted page as promoted — the ad wins', () => {
    const text = [
      'Feed post',
      'Dale Walden follows this page',
      'Web Summit',
      '248,166 followers',
      'Promoted',
      'Join us in Lisbon this November.',
    ].join('\n');

    expect(classifyPost(text)).toBe(QUIET_CATEGORY.PROMOTED);
    expect(extractHeader(text)).toBe('Dale Walden follows this page');
  });

  it('reads "<Name> follows this page" on its own as somebody a connection follows', () => {
    const text = [
      'Feed post',
      'Dale Walden follows this page',
      'Web Summit',
      '248,166 followers',
      'Join us in Lisbon this November.',
    ].join('\n');

    expect(classifyPost(text)).toBe(QUIET_CATEGORY.FOLLOWED_BY);
  });

  it('reads a Follow button as an unlabelled suggestion', () => {
    const text = [
      'Feed post',
      'Aly Moursy',
      '• 3rd+',
      'Founder & CEO, Veeza AI (YC F26)',
      '1d • Edited •',
      'Follow',
      'Since I have been in SF the pace of everything has changed…',
    ].join('\n');

    expect(classifyPost(text)).toBe(QUIET_CATEGORY.NOT_FOLLOWED);
    expect(extractHeader(text)).toBe(null);
  });

  it('reads "+ Follow" the same way', () => {
    const text = ['Feed post', 'Aly Moursy', '• 3rd+', 'Founder', '1d •', '+ Follow', 'A post.'];
    expect(classifyPost(text.join('\n'))).toBe(QUIET_CATEGORY.NOT_FOLLOWED);
  });

  it('leaves a page you already follow alone — no follower line, no button', () => {
    const text = [
      'Feed post',
      'Ethos BeathChapman',
      '1w • Edited •',
      'How long is your notice period, and has anybody ever enforced it?',
    ].join('\n');

    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('reads a standalone "Following" as somebody you do follow', () => {
    const text = ['Feed post', 'Aly Moursy', '• 3rd+', 'Founder', '1d •', 'Following', 'A post.'];
    expect(classifyPost(text.join('\n'))).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('leaves the user’s own draft and the sort control alone', () => {
    expect(classifyPost('Draft:\nTired of AI slop in your LinkedIn feed?')).toBe(
      QUIET_CATEGORY.UNKNOWN,
    );
    expect(classifyPost('Sort by: Top')).toBe(QUIET_CATEGORY.UNKNOWN);
  });

  it('counts the post’s own age as an author block, so a page post is a post', () => {
    for (const age of ['1d •', '3h •', '1w • Edited •', '2mo •', '45m •']) {
      const text = ['Feed post', 'Ethos BeathChapman', age, 'A thought.'].join('\n');
      expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
      expect(authorBlockIndex(lines(text))).toBe(1);
    }
  });
});

/* ================================================================== */
/*  The signals that are not headers                                  */
/* ================================================================== */

describe('“Promoted” and the Follow button', () => {
  /** A post by somebody you do not follow, with `extra` where the button sits. */
  const withLine = (extra) =>
    ['Feed post', 'Marcus Webb', '• 2nd', 'Head of Data', '1d •', extra, 'A post.'].join('\n');

  it('does not read the word "Follow" inside a longer line as a button', () => {
    for (const line of ['Follow us on Instagram', 'Follow-up call booked', 'Followers: 12']) {
      expect(classifyPost(withLine(line))).toBe(QUIET_CATEGORY.DIRECT);
    }
  });

  it('does not read a Follow button buried in a post’s body as a button', () => {
    const text = [
      'Feed post',
      'Marcus Webb',
      '• 2nd',
      'Head of Data at Northwind',
      '1d •',
      'A long thought about hiring.',
      'Line two.',
      'Follow',
    ].join('\n');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('does not read "Promoted" further down a post as an ad', () => {
    const text = [
      'Feed post',
      'Marcus Webb',
      '• 2nd',
      'Head of Data at Northwind',
      '1d •',
      'We just promoted three people.',
      'Promoted',
    ].join('\n');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('does not read "Software · 1,234 followers" as an author block', () => {
    const text = 'Vellum Ltd\nSoftware · 1,234 followers\nFollow';
    expect(authorBlockIndex(lines(text))).toBe(-1);
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.UNKNOWN);
  });

  it('prefers the header to the Follow button when a post has both', () => {
    const text = [
      'Feed post',
      'Priya Raman likes this',
      'Aly Moursy',
      '• 3rd+',
      'Founder',
      '1d •',
      'Follow',
      'A post.',
    ].join('\n');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.REACTION);
  });

  it('prefers "Promoted" to everything else', () => {
    const text = [
      'Feed post',
      'Priya Raman likes this',
      'Vellum Ltd',
      '12K followers',
      'Promoted',
      'Buy our thing.',
    ].join('\n');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.PROMOTED);
  });
});

/* ================================================================== */
/*  Groups and recommendation modules                                 */
/* ================================================================== */

/**
 * The second live run's two leftovers. Neither has a header, and neither could
 * be reached by any rule that starts from one.
 *
 * A group post announces the group where a header would go and then runs the
 * author's name and degree together on one line. A recommendation module is not
 * a post at all — no author, no author block — and says so in its first line.
 */
describe('posts in groups you have joined', () => {
  const groupPost = (group, author, degree = '• 3rd+', age = '1h • Edited •') =>
    ['Feed post', group, `${author} ${degree}`, age, 'A thought about hiring.'].join('\n');

  it('reads a group post by its group name over an inline author line', () => {
    expect(classifyPost(groupPost('The Recruitment Network', 'Tariq Mahmood'))).toBe(
      QUIET_CATEGORY.GROUP,
    );
    expect(classifyPost(groupPost('The Recruiter Network', 'Marcel Kruger', '• 2nd', '7h •'))).toBe(
      QUIET_CATEGORY.GROUP,
    );
  });

  it('does not read a plain person’s post as a group post', () => {
    // The tell is the shape: name on its own line, bare degree under it.
    const plain = ['Feed post', 'Yunfan Ye', '• 3rd+', 'Engineer', '1h •', 'A post.'].join('\n');
    expect(classifyPost(plain)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('does not read an inline author line with nothing above it as a group post', () => {
    const inline = ['Feed post', 'Marcus Webb • 2nd', 'Head of Data', '1d •', 'A post.'].join('\n');
    expect(classifyPost(inline)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('prefers a real header to the group rule', () => {
    const text = [
      'Feed post',
      'Priya Raman likes this',
      'Marcus Webb • 2nd',
      '1d •',
      'A post.',
    ].join('\n');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.REACTION);
  });

  it('prefers "Promoted" to the group rule', () => {
    const text = ['Feed post', 'Vellum Ltd', 'Marcus Webb • 2nd', 'Promoted', 'Buy this.'].join(
      '\n',
    );
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.PROMOTED);
  });

  it('does not take a paragraph of prose for a group name', () => {
    const prose = 'x'.repeat(GROUP_NAME_MAX + 1);
    const text = ['Feed post', prose, 'Marcus Webb • 2nd', '1d •', 'A post.'].join('\n');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
  });
});

describe('recommendation modules', () => {
  const headings = [
    'Jobs recommended for you',
    'Recommended for you',
    'People you may know',
    'Add to your feed',
    'Suggested for you',
    'Trending now',
  ];

  for (const heading of headings) {
    it(`reads "${heading}" as a recommendation`, () => {
      const text = ['Feed post', heading, 'Jane Roe', '15k+ | HR Specialist', 'Follow'].join('\n');
      expect(classifyPost(text)).toBe(QUIET_CATEGORY.RECOMMENDATION);
    });
  }

  it('reads the jobs module, which has no author of any kind', () => {
    const text = [
      'Feed post',
      'Jobs recommended for you',
      'AI Engineer (Agents)',
      'Vellum Ltd · Remote',
    ].join('\n');
    expect(authorBlockIndex(lines(text))).toBe(-1);
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.RECOMMENDATION);
  });

  it('reads it with or without the "Feed post" prefix', () => {
    expect(classifyPost('Add to your feed\nNorthwind Analytics\nFollow')).toBe(
      QUIET_CATEGORY.RECOMMENDATION,
    );
  });

  it('wants the whole line, not a phrase inside somebody’s post', () => {
    const text = [
      'Feed post',
      'Marcus Webb',
      '• 2nd',
      'Head of Data',
      '1d •',
      'Recommended for you: three books I finished this month.',
    ].join('\n');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('is not fooled by a heading further down the item', () => {
    const text = ['Feed post', 'Marcus Webb', '• 2nd', '1d •', 'People you may know'].join('\n');
    expect(classifyPost(text)).toBe(QUIET_CATEGORY.DIRECT);
  });

  it('still leaves the draft box, the composer and the sort control alone', () => {
    expect(classifyPost('Draft:\nTired of AI slop in your LinkedIn feed?')).toBe(
      QUIET_CATEGORY.UNKNOWN,
    );
    expect(classifyPost('Start a post\nVideo\nPhoto\nWrite article')).toBe(QUIET_CATEGORY.UNKNOWN);
    expect(classifyPost('Sort by: Top\nRecent')).toBe(QUIET_CATEGORY.UNKNOWN);
  });
});
