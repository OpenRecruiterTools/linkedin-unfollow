# The fallback engine

The default engine sends the two requests linkedin.com's own Following page
sends. The list call depends on a hashed `queryId`:

```
voyagerSearchDashClusters.e438ab99259203e9c1cd3f358e217282
```

LinkedIn rotates those. When it does, the list call starts coming back with
nothing in it and "Check count" says you follow nobody, while the page itself
plainly works. Two ways out.

## 1. Re-capture the query id (five minutes, fixes it properly)

1. Open <https://www.linkedin.com/mynetwork/network-manager/people-follow/following/>.
2. Open DevTools → Network, filter on `graphql`.
3. Scroll the list so it loads another page.
4. Find the request whose `variables` contain `MYNETWORK_CURATION_HUB` and
   `PEOPLE_FOLLOW`. Copy the `queryId` off the end of its URL.
5. Put it in `FOLLOWING_QUERY_ID` in `src/linkedin.js` and reload the extension
   at `chrome://extensions`.

A pull request with the new id is welcome and takes one line.

## 2. Use the DOM engine instead (works regardless)

`src/dom-fallback.js` is the original engine: it drives the Following page in
your active tab, clicking each `button[aria-label^="Click to stop following"]`
and waiting for the label to flip to "Click to follow", paging by scrolling. It
depends on accessible names rather than the API, so a rotated query id cannot
break it.

It is the fallback rather than the default because it is far slower — 2–5
seconds per person, so 785 people is about an hour — and because it needs the
tab left alone for the whole run. It stops if the tab navigates away, is closed,
or lands on a checkpoint page, and it never touches any tab but the one you
started it on.

The router already speaks to it. Anything that can send the extension a message
can ask for it by adding `mode: 'dom'`:

```js
chrome.runtime.sendMessage({ type: 'count', mode: 'dom' });
chrome.runtime.sendMessage({ type: 'preview', limit: 25, mode: 'dom' });
chrome.runtime.sendMessage({ type: 'unfollow', limit: 25, mode: 'dom' });
```

To make it the route the buttons use, add `mode: 'dom'` to the `call(...)` in
`src/popup/popup.js` — there are three of them — and reload the extension. Open
your Following list in the tab first, and leave that tab alone while it runs.

Both engines are tested to the same standard: `tests/dom-fallback.test.js` runs
the click engine against a jsdom copy of the Following page.
