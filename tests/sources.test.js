#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  compactSource,
  hostMatchesDomain,
  isCitationMarker,
  isOffDomainExtra,
  mergeSources,
  parseXPostUrl,
  selectSources,
} from "../scripts/lib/sources.js";

assert.deepEqual(parseXPostUrl("https://x.com/xai/status/1975607901571199086"), {
  x_handle: "xai",
  x_post_id: "1975607901571199086",
});
assert.deepEqual(parseXPostUrl("https://twitter.com/elonmusk/statuses/123?s=20"), { x_handle: "elonmusk", x_post_id: "123" });
assert.deepEqual(parseXPostUrl("https://mobile.x.com/xai/status/123"), { x_handle: "xai", x_post_id: "123" });
assert.deepEqual(parseXPostUrl("https://x.com/xai/status/123/photo/1"), { x_handle: "xai", x_post_id: "123" });
// X's own routes are not handles. Only /<handle>/status/<id> names an author, so the
// canonical /i/web/status/<id> form must not be attributed to "@web".
assert.deepEqual(parseXPostUrl("https://x.com/i/status/1975607901571199086"), { x_post_id: "1975607901571199086" });
assert.deepEqual(parseXPostUrl("https://x.com/i/web/status/1975607901571199086"), { x_post_id: "1975607901571199086" });
// Profile URLs from user search still yield attribution.
assert.deepEqual(parseXPostUrl("https://x.com/xai"), { x_handle: "xai" });
assert.equal(parseXPostUrl("https://x.com/about"), null);
assert.equal(parseXPostUrl("https://x.com/login"), null);
assert.equal(parseXPostUrl("https://x.com/i/user/1912644073896206336"), null);
assert.equal(parseXPostUrl("https://x.com/xai/status/not-a-number"), null);
assert.equal(parseXPostUrl("https://example.com/xai/status/123"), null);
assert.equal(parseXPostUrl("https://notx.com/xai/status/123"), null);
assert.equal(parseXPostUrl(""), null);

const xCompacted = compactSource(
  { provider: "grok-responses", url: "https://x.com/xai/status/123", title: "@xai", x_handle: "xai", x_post_id: "123" },
  { sourceChars: 400 }
);
assert.deepEqual(xCompacted, {
  provider: "grok-responses",
  url: "https://x.com/xai/status/123",
  title: "@xai",
  x_handle: "xai",
  x_post_id: "123",
});

assert.deepEqual(
  mergeSources([{ url: "https://A.example/path/" }], [{ url: "https://a.example/path#section" }, { url: "https://b.example/" }]).map(
    (source) => source.url
  ),
  ["https://A.example/path/", "https://b.example/"]
);

// A duplicate URL fills in what the first record lacks: a marker title gives way to a real
// one, the description becomes the snippet, and the contributing provider is recorded.
const mergedCitation = mergeSources(
  [{ provider: "grok-responses", source_type: "citation", url: "https://example.com/post", title: "1" }],
  [{ provider: "firecrawl", url: "https://example.com/post/", title: "Great Post Title", description: "A useful description", score: 0.5 }]
);
assert.deepEqual(mergedCitation, [
  {
    provider: "grok-responses",
    source_type: "citation",
    url: "https://example.com/post",
    title: "Great Post Title",
    snippet: "A useful description",
    score: 0.5,
    merged_from: ["firecrawl"],
  },
]);
// Existing real values are never overwritten, and an identical duplicate leaves no trace.
const keptTitle = mergeSources(
  [{ provider: "grok-responses", url: "https://example.com/a", title: "Original", snippet: "kept" }],
  [{ provider: "tavily", url: "https://example.com/a", title: "Other", description: "ignored" }]
);
assert.equal(keptTitle[0].title, "Original");
assert.equal(keptTitle[0].snippet, "kept");
assert.equal(Object.hasOwn(keptTitle[0], "merged_from"), false);
assert.equal(isCitationMarker("1"), true);
assert.equal(isCitationMarker("[12]"), true);
assert.equal(isCitationMarker("Issue #12"), false);

// Domain matching is by host suffix; extras outside the requested domains are recognised,
// Grok's own sources never are (its filter is applied server-side).
assert.equal(hostMatchesDomain("gist.github.com", "github.com"), true);
assert.equal(hostMatchesDomain("github.com", "github.com"), true);
assert.equal(hostMatchesDomain("notgithub.com", "github.com"), false);
assert.equal(hostMatchesDomain("raw.githubusercontent.com", "github.com"), false);
const filters = { allowedDomains: ["github.com"], excludedDomains: [] };
assert.equal(isOffDomainExtra({ provider: "firecrawl", url: "https://medium.com/p" }, filters), true);
assert.equal(isOffDomainExtra({ provider: "firecrawl", url: "https://github.com/o/r" }, filters), false);
assert.equal(isOffDomainExtra({ provider: "grok-responses", source_type: "searched", url: "https://medium.com/p" }, filters), false);
assert.equal(isOffDomainExtra({ provider: "tavily", url: "https://reddit.com/r/x" }, { allowedDomains: [], excludedDomains: ["reddit.com"] }), true);
assert.equal(isOffDomainExtra({ provider: "tavily", url: "https://medium.com/p" }, { allowedDomains: [], excludedDomains: [] }), false);

// compactSource carries the new flags through.
assert.deepEqual(
  compactSource({ provider: "grok-responses", url: "https://example.com/o", source_type: "searched", opened: true, merged_from: ["tavily"] }),
  { provider: "grok-responses", url: "https://example.com/o", source_type: "searched", opened: true, merged_from: ["tavily"] }
);

const compacted = compactSource(
  {
    provider: "tavily",
    title: "  Example  ",
    url: "https://example.com/a",
    description: "abcdefghijklmnopqrstuvwxyz",
    score: 0.91,
    published_date: "2026-06-22",
    raw_extra: { hidden: true },
  },
  { sourceChars: 10 }
);
assert.deepEqual(compacted, {
  provider: "tavily",
  url: "https://example.com/a",
  title: "Example",
  snippet: "abcdefghij",
  score: 0.91,
  published_date: "2026-06-22",
});
assert.equal(Object.hasOwn(compacted, "description"), false);
assert.equal(Object.hasOwn(compacted, "content"), false);

const noSnippet = compactSource({ provider: "grok", url: "https://example.com/b", description: "hidden" }, { sourceChars: 0 });
assert.deepEqual(noSnippet, { provider: "grok", url: "https://example.com/b" });

const rankedSources = [
  { url: "https://e.example/1", source_type: "searched" },
  { url: "https://e.example/2", provider: "tavily" },
  { url: "https://e.example/3", source_type: "citation" },
  { url: "https://e.example/4", source_type: "searched" },
];
const capped = selectSources(rankedSources, { maxSources: 2 });
// Citation and extra-provider sources outrank searched-only ones; the picked
// subset keeps the original order.
assert.deepEqual(
  capped.items.map((source) => source.url),
  ["https://e.example/2", "https://e.example/3"]
);
assert.equal(capped.total, 4);
assert.equal(capped.returned, 2);
assert.equal(capped.omitted, 2);

const uncapped = selectSources(rankedSources, { maxSources: 10 });
assert.equal(uncapped.returned, 4);
assert.equal(uncapped.omitted, 0);
assert.deepEqual(selectSources([], { maxSources: 5 }), { items: [], total: 0, returned: 0, omitted: 0 });

// Full ranking: citation > opened > in-domain extra > searched > off-domain extra.
const domainRanked = [
  { url: "https://medium.com/off", provider: "firecrawl" },
  { url: "https://github.com/searched", source_type: "searched" },
  { url: "https://github.com/opened", source_type: "searched", opened: true },
  { url: "https://gist.github.com/extra", provider: "tavily" },
  { url: "https://github.com/cited", source_type: "citation" },
];
const domainFilters = { allowedDomains: ["github.com"], excludedDomains: [] };
assert.deepEqual(
  selectSources(domainRanked, { maxSources: 1, ...domainFilters }).items.map((source) => source.url),
  ["https://github.com/cited"]
);
assert.deepEqual(
  selectSources(domainRanked, { maxSources: 2, ...domainFilters }).items.map((source) => source.url),
  ["https://github.com/opened", "https://github.com/cited"]
);
assert.deepEqual(
  selectSources(domainRanked, { maxSources: 4, ...domainFilters }).items.map((source) => source.url),
  ["https://github.com/searched", "https://github.com/opened", "https://gist.github.com/extra", "https://github.com/cited"]
);
// Without filters the extra keeps its place ahead of searched-only sources.
assert.deepEqual(
  selectSources(domainRanked, { maxSources: 4 }).items.map((source) => source.url),
  ["https://medium.com/off", "https://github.com/opened", "https://gist.github.com/extra", "https://github.com/cited"]
);

console.log("sources fixtures ok");
