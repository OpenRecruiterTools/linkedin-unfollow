/**
 * Three lines, because Chrome will not load a module as a content script.
 *
 * `quiet-feed.js` imports its classifier and the shared constants, and MV3 has
 * no `"type": "module"` for `content_scripts` — so the manifest points here, at
 * a plain script, and this pulls the module in by URL. The import runs in the
 * content script's own isolated world with the content script's own access to
 * `chrome.storage`; it is the documented way round the gap, and it keeps
 * `src/` free of a build step and of a copy of the classifier.
 *
 * The three files it reaches are listed in `web_accessible_resources`. They are
 * the same files you can read in this repository; there is nothing in them that
 * linkedin.com could not already see.
 */
import(chrome.runtime.getURL('src/content/quiet-feed.js')).catch((error) => {
  console.error('[LinkedIn Unfollow] quiet feed did not load:', error);
});
