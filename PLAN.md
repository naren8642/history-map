# History Map — Design Plan

An interactive world map with a time scrubber. Pick a place and a period; see what
happened there, sourced from Wikidata + Wikipedia.

---

## 1. The core loop

Three pieces of coupled state drive everything:

| State | Source of truth | Changes on |
|---|---|---|
| `viewport` | MapLibre camera | pan / zoom |
| `window` | timeline control | scrub / resize |
| `selected` | pin click | click / Esc |

`(viewport, window)` → **query** → ranked event list → pins.
`selected` → **hydrate** → Wikipedia summary → detail panel.

Everything below exists to make that loop fast and legible.

---

## 2. Architecture decision

**Static SPA + a dataset baked at build time. No backend, no database.**

This was not the obvious answer going in. It was settled by measurement.

### What was measured (live, against production endpoints)

```
global COUNT over dated+geolocated items ........ TIMEOUT (>65s)
Europe bbox + 1800–1850 + rank by sitelinks ..... TIMEOUT (>60s)   ← the naive app query
date-first, no bbox, 1000 rows ..................  0.66s
```

`SERVICE wikibase:box` against Wikidata's **12,148,514** coordinate-bearing items is the
bottleneck. This matters more than it first appears: *every* live or cache-on-demand design
is inherently bbox-shaped, which is exactly the shape that times out. A hybrid cache would
make each cold pan a coin-flip against a 60-second hang, and would only help someone after
a previous user had already absorbed that hang.

Harvesting **date-first** is fast, and we never ask Wikidata a spatial question at all —
we do the spatial indexing ourselves, offline.

### What makes "no backend" viable

Measured payload density: **~104 bytes/event** for index fields (QID, label, coordinate,
date, sitelink count), stable to ±3% across four sampled eras from 500 BCE to 1950.

| Slice | Events | Raw | Gzipped |
|---|---|---|---|
| `P585` point-in-time + coords | ~50,000 | 5.0 MB | ~1.5 MB |
| `P580/P582` spans + coords | ~50,600 | 5.0 MB | ~1.5 MB |
| `P571` inception, sitelinks ≥ 20 | ~100,000 est. | 10 MB | ~3.0 MB |
| **v1 total (deduped)** | **~180,000** | **~19 MB** | **~5.5 MB** |

The client never loads all of it — see bucketing (§4). And both runtime APIs send
`access-control-allow-origin: *`, so the browser calls Wikipedia's summary endpoint
directly. It is CDN-cached at `s-maxage=1209600` (two weeks).

**Consequence: the only "backend" is an offline harvest script. Deploys to any static host.**

---

## 3. Data pipeline (`scripts/harvest.ts`)

Run manually or on a monthly CI cron. Never in the request path.

### 3.1 Sources

| Property | Meaning | Role |
|---|---|---|
| `P625` | coordinate location | required — the pin |
| `P585` | point in time | instant events (battles, treaties, disasters) |
| `P580` / `P582` | start / end time | span events (wars, sieges, reigns) |
| `P571` | inception | structures — **gated at sitelinks ≥ 20** |
| `P31` | instance of | event type, for filtering/iconography |
| `wikibase:sitelinks` | language-edition count | notability rank |

### 3.2 The P571 gate

`P571` + coords is ~1.37M items — mostly parish churches and village foundings. Unfiltered
it costs 25× the payload and drowns actual history. Measured selectivity on the 1850s:

```
all P571 + coords, 1850–1860 .... 23,887
same, sitelinks >= 20 ...........  1,799   (7.5% survive — 13× reduction)
```

Threshold **20** is the v1 default. It is a single constant; tune it after seeing the map.

### 3.3 Chunking and retries

WDQS has a hard 60s timeout, so the harvest walks date ranges rather than issuing one
big query. Chunk width must adapt — a `P585` century returns in ~1s, but a `P571` century
times out.

```
harvest(prop, from, to, threshold):
  try query(prop, from, to, threshold)          # 55s budget
  on timeout or >20k rows:
    split [from,to) in half, recurse            # min width: 1 year
  on 429/5xx:
    exponential backoff, 3 attempts
```

Note: one observed oddity — `P571 sitelinks>=10` timed out for the 1850s while both
`>=0` and `>=20` succeeded. Mid-selectivity filters can pick a bad query plan. The
adaptive splitting handles this without special-casing.

Politeness: descriptive `User-Agent` with contact address, ~1 req/sec, serial not parallel.

### 3.4 Normalization

- Parse WKT `Point(lon lat)` → `[lon, lat]`, rounded to 4 dp (~11 m; plenty, saves bytes).
- Wikidata dates are ISO-ish with negative years for BCE and varying precision. Normalize
  to a signed integer **year** plus a `precision` enum (`day|month|year|decade|century`).
  Year is what the timeline filters on; precision drives display ("c. 1200" vs "18 Jun 1815").
- Spans become `{start, end}`; instants become `{start: y, end: y}`. One uniform shape.
- Dedupe by QID, preferring `P585` over `P580` over `P571` when an item has several.
- Drop items with no English label (can't render a useful pin).

### 3.5 Output record

```jsonc
{ "q": 178140,          // QID integer, "Q" implied
  "n": "Battle of Waterloo",
  "c": [4.4022, 50.6803],
  "s": 1815, "e": 1815, // start/end year, signed
  "p": "day",           // date precision
  "t": 178561,          // P31 type QID (battle)
  "r": 92 }             // sitelink count = rank
```

---

## 4. Bucketing scheme

Deliberately simple, with one escape hatch. Do **not** build a full quadtree up front.

### 4.1 Time buckets, non-uniform

Event density is enormously skewed toward the present, so buckets widen going back:

| Era | Bucket width |
|---|---|
| before 1000 BCE | one bucket |
| 1000 BCE – 0 | 250 y |
| 0 – 1500 | 100 y |
| 1500 – 1800 | 50 y |
| 1800 – 1900 | 25 y |
| 1900 – present | 10 y |

≈ 50 buckets. Each becomes one file, events sorted by rank descending.
Average ~400 KB raw / ~120 KB gzipped.

A typical window overlaps 1–3 buckets. The client fetches those, filters bbox in memory.
No geo tiling needed — bbox filtering 10k in-memory records is sub-millisecond.

### 4.2 The escape hatch

Any bucket exceeding **500 KB raw** (the modern ones, once P571 structures land) is split
geographically into z=3 tiles, emitting only non-empty tiles. A `manifest.json` records,
per bucket, whether it is monolithic or tiled and which tiles exist — so the client always
knows what to fetch without probing for 404s.

```
public/data/
  manifest.json
  t/-1000.json          # monolithic bucket
  t/1900/3-4-2.json     # tiled bucket, z-x-y
```

### 4.3 Overview layer

For zoomed-out views, a per-bucket `top.json` holding the highest-ranked ~500 events.
Loads instantly at world zoom; the full bucket streams in behind it.

---

## 5. Timeline control

**A draggable window with adjustable width**, on a non-linear axis.

### 5.1 Why non-linear

Linear over 3000 BCE → 2026 puts everything before the Renaissance in the leftmost 15%
of the bar. Unusable.

Pixel → year is a **monotonic piecewise-linear** function whose control points are the
time-bucket boundaries from §4.1, with screen width allocated per era proportional to
`sqrt(event count)` in that era. Square root, not linear: linear allocation would still
crush antiquity, while giving every era equal width would make the modern era feel
absurdly sparse. Density data comes from the manifest, so the axis auto-adapts if the
corpus shifts.

### 5.2 Interaction

- Drag the window body → pan through time.
- Drag either edge, or use a width control (**decade / century / millennium** presets) → resize.
- A density histogram is drawn *behind* the axis, so the user can see where history is.
- Keyboard: `←/→` step by one bucket, `shift` for a larger jump.
- Query fires on `requestAnimationFrame`-throttled scrub, so pins move live while dragging.
  This is affordable precisely because data is local — a real advantage of the baked dataset.

---

## 6. Map and rendering

- **MapLibre GL JS** — vector tiles, free, no API key lock-in.
- Basemap: a muted/grayscale style so pins carry the color. Default **Protomaps** (a
  self-hostable `.pmtiles` file, matching the no-backend posture); CARTO Positron is the
  fallback if that proves fiddly. *Decision deferred to implementation.*
- Pins as a MapLibre `symbol` layer fed by a GeoJSON source — keeps 10k markers on the
  GPU rather than in the DOM.
- Clustering via **supercluster**, with `map` / `reduce` set so a cluster inherits the
  **max rank** of its children. Cluster labels then show the most notable event's name
  rather than a bare count — far more informative at world zoom.
- Pin size and opacity scale with rank; below a zoom-dependent rank floor, pins are hidden
  entirely rather than clustered. Zooming in lowers the floor: *"zoom in for more"* is the
  organizing principle for density.

---

## 7. Detail panel

Click a pin → slide-over panel:

1. Immediate render from local data (title, formatted date, type) — **zero latency**.
2. Fetch `https://en.wikipedia.org/api/rest_v1/page/summary/{title}` for extract + thumbnail
   (~3 KB, measured). Skeleton state while in flight.
3. Cache summaries in an in-memory LRU + `sessionStorage`.
4. "Read on Wikipedia" link out; "Show on Wikidata" secondary.

Title comes from the harvested `sitelink`, not the label — they differ often enough
(disambiguators) to break the fetch otherwise. **Add `title` to the harvest record.**

---

## 8. URL state

`?y=1815&w=50&lat=50.68&lng=4.40&z=7&q=178140`

Every view is shareable and back/forward navigable. Debounced `replaceState` on
map/timeline move; `pushState` only on pin selection.

---

## 9. Stack

| Concern | Choice |
|---|---|
| Build | Vite + React + TypeScript |
| Map | MapLibre GL JS |
| Clustering | supercluster |
| State | Zustand (three small slices matching §1) |
| Styling | Tailwind |
| Harvest | Node + TypeScript, run via `tsx` |
| Deploy | any static host |

---

## 10. Milestones

1. **Harvest spike** — script pulls `P585` only, writes flat JSON. Confirms chunking and
   normalization against real data. *Output: a file we can eyeball.*
2. **Map + pins, fixed date** — MapLibre, one hardcoded time bucket, pins render. Proves the
   rendering path before adding time.
3. **Timeline** — non-linear axis, draggable window, live scrub. **This is the milestone that
   determines whether the app feels good**; budget time to iterate on it.
4. **Detail panel** — Wikipedia hydration, caching, loading states.
5. **Density work** — clustering, rank floors, overview layer. Only tunable once 2–4 exist.
6. **Full corpus** — add `P580/P582` and gated `P571`; implement bucket splitting.
7. **Polish** — URL state, keyboard nav, mobile layout, empty/error states.

---

## 11. Risks and open questions

- **Anachronistic basemap.** Modern borders under ancient events; Waterloo pins onto
  present-day Belgium. Acceptable for v1, but worth a subtle UI acknowledgement.
- **Coverage bias.** Wikidata is heavily Euro/US-weighted and modern-weighted. Large regions
  and eras will look empty, and that emptiness reflects the *dataset*, not history. Consider
  saying so in the UI rather than letting the map imply nothing happened.
- **Sitelinks as notability.** A decent proxy that also encodes Wikipedia's own biases.
  Compounds the point above.
- **Date precision.** Many items carry century-precision dates. Rendering them as points on
  a fine-grained timeline overstates confidence; precision should be visible.
- **`P31` type taxonomy is messy** — thousands of distinct values, deep hierarchies. v1
  should map only a curated handful to icons and bucket the rest as "other" rather than
  attempting full ontology traversal.
- **Corpus staleness.** No auto-refresh. A monthly CI job is the intended fix.

---

## 12. Roadmap beyond v1

- **Historical borders** *(requested for the roadmap)*. Time-varying border overlay so the
  map matches the era. Open GeoJSON sets exist but are coarse, patchy, and disagree with
  each other; this is a project in its own right, not a feature. Deliberately deferred.
- Play/animate the time window.
- Event-type filters and full-text search across the local corpus.
- Non-English Wikipedia summaries.
- Linked events (`P710` participants, `P155/P156` follows/followed-by) as map connections.

---

## 13. Milestone 1 findings (harvest spike)

Ran against live WDQS: **43,014 events**, 50 queries, 354s, 5.54 MB raw / **1.25 MB gzipped**
at **135 bytes/event**. Projection in §2 was 1.5 MB — close enough to trust the rest.

### Confirmed

- Adaptive chunking works. 48 seeded chunks, exactly one needed bisection (2010–2020).
- Integrity is clean: 0 out-of-range coords, 0 null-island, 0 duplicate QIDs.
- `P31` coverage is **99.2%** — type-based filtering is fully viable (see below).
- Rejections: 9.6% no usable label, 15 bad coords.

### Corrected

- **WDQS can fail without signalling failure.** A dense decade returned HTTP 200 with a body
  truncated mid-JSON at ~852 KB; the first run silently dropped the 1950s and still exited 0.
  Now caught as `TruncatedResponse`. It proved *transient* — the same range succeeded on
  retry — so truncation retries first and escalates to bisection only if it persists.
  **A nonzero PROBLEMS count must fail the build in CI.**
- **English article coverage is 59.5%, not the ~74% seen in the 1800–1850 sample.** Four in ten
  events have no article to summarize. The detail panel needs a real no-summary state.

### The ranking problem (needs a decision)

§6 assumed sitelink count ≈ historical importance. **It does not.** It measures
modern global media attention. Actual top-ranked events, unfiltered:

```
132  2012 Summer Olympics        118  2024 Summer Olympics
126  2020 Summer Olympics        111  Charter of the United Nations
125  Chernobyl disaster          110  2014 Winter Olympics
122  US Declaration of Indep.    105  2010 Winter Olympics
```

Two distortions compound it:

1. **Solar eclipses are 22.3% of the corpus** (9,573 events). Machine-generated astronomical
   records with coordinates, spread evenly across all of history. Not history.
2. **Sports dominate the notable tier.** Of 4,006 events at rank ≥ 20, recurring sporting
   editions and Olympic discipline sub-events account for ~1,600 — versus 462 battles.

Excluding eclipses plus sports sub-events leaves 28,681 events (66.7%) and halves the
notable tier to 2,053 — but the Olympics still top the list, because the *parent* event is
a different `P31` class again. Rank alone will not fix this; a curated type policy is required.

### Also surfaced: coordinate stacking

84 coordinates carry ≥15 events each. The worst is the US Capitol (`-77.0089, 38.8897`)
with **160** — every State of the Union address, stacked on one point alongside the 1814
Burning of Washington. These are venue/centroid coordinates, not event sites. Pins must
handle co-located events (spider/expand on click), and §6's clustering needs a
same-coordinate case distinct from the proximity case.

### Type curation (resolved: curated allowlist)

Split into two stages — `harvest.ts` (~6 min against WDQS) and `curate.ts` (local, ~2s).
Curation reads the raw harvest rather than re-querying, so revising the allowlist is a
seconds-long loop. That is what makes "start narrow, expand later" practical.

**Result: 43,014 raw → 19,668 curated (45.7%), 2.82 MB raw / 0.65 MB gzipped.**

Because an allowlist fails *silently*, `curate.ts` reports every unreviewed type ranked by
notable-event count — an explicit to-do list for expanding `taxonomy.ts`. This caught real
history the first narrow list was discarding:

| Wikidata type | was dropping |
|---|---|
| `fusillade` | assassination of Archduke Franz Ferdinand |
| `incident` | Boston Tea Party |
| `oration` | I Have a Dream |
| `ground collision` | Tenerife airport disaster |
| `synod` | Second Council of Ephesus |

Three passes took the tail from 88 notable events per unreviewed type down to 6 — a clear
convergence signal. `DELIBERATELY_EXCLUDED` records rejections *with reasons*, so the report
lists only genuinely unreviewed types instead of re-surfacing eclipses forever.

Top of the curated corpus now reads as history — Paris attacks, Waterloo, Tiananmen,
2004 Indian Ocean earthquake, Hastings, Trafalgar, **Battle of Marathon (489 BCE)** — where
the unfiltered list was four Olympic Games in the top five.

Two side effects worth noting:
- **Coordinate stacking largely dissolved**: coords with ≥15 events fell from 84 to 3. Most
  stacking was recurring sports at fixed venues. The US Capitol case remains, deliberately
  kept as the test fixture for co-located pins.
- **Era balance improved**: pre-1000 CE now 1,024 events against 11,970 post-1900. Still
  modern-weighted — that is Wikidata, not a bug — but no longer swamped.

### Roadmap addition: LLM-synthesized place narratives

Requested for a later iteration. The fit is good and specifically **build-time, not in-loop**:
in-loop synthesis would require a server and an API key, discarding the static-SPA property
that §2 established. Build-time synthesis keeps it.

The shape: for each place with several events, feed the structured event list to a model and
generate a short "what happened here" narrative, baked into the dataset like everything else.
Cheap at this scale, zero runtime cost, no key in the client.

Editorial constraint: synthesized prose would sit beside Wikipedia-sourced text, so it must be
visibly labelled as generated and kept clearly subordinate to the cited article. A history app
that blurs sourced and synthesized text is doing the reader a disservice.

---

## 14. Milestone 2 findings (map + pins, fixed window)

Vite + React + MapLibre, window pinned to 1900–1950 (2,582 events). Cluster drill-down,
notability-scaled pins, category colouring, rank floor, and click-to-select all verified in
the browser. Production build: 313 KB gzipped JS, dominated by MapLibre.

### Basemap decision (was deferred in §6)

**CARTO Positron**, keyless, 93 layers. OpenFreeMap (`tiles.openfreemap.org/styles/positron`)
was also verified keyless and is the documented fallback. Both preserve static deploy.

### Three failure modes, none of which announced themselves

Worth recording because all three presented identically — a blank map, no thrown error:

1. **MapLibre's web worker 404s under Vite's dependency pre-bundler.** Vite rewrites the main
   entry into `.vite/deps` but does not emit `maplibre-gl-worker.mjs` beside it. MapLibre needs
   it to parse vector tiles, so the style never finishes loading. Fixed with
   `optimizeDeps.exclude: ['maplibre-gl']`. **This is a real bug, not environment-specific.**
2. **Vite injects CSS asynchronously in dev**, so the map container can still be 0×0 when the
   `Map` is constructed. MapLibre then falls back to a 400×300 canvas and keeps it forever.
   Fixed by calling `resize()` in the `load` handler. A `ResizeObserver` alone is *not*
   sufficient — see below.
3. **Hidden tabs have no frame source.** Preview panes can host their tab permanently at
   `visibilityState: 'hidden'`, where browsers never fire `requestAnimationFrame`. MapLibre
   drives its whole render loop from rAF, so the map silently never loads. `ResizeObserver`
   is affected too — its callbacks are delivered through the same rendering pipeline.
   A dev-only timer-based frame source (`src/lib/hidden-tab-raf.ts`) restores rendering; it is
   gated on `import.meta.env.DEV && document.hidden` and verified absent from prod output.

The lesson generalizing across all three: **MapLibre fails silently by default.** `map.on('error')`
is the only channel for tile, sprite, glyph, and worker failures, and it is now wired to the
console. Diagnosing without it meant guessing.

### Confirmed by observation

- **Rank floor works as designed.** Zoom 1.6 → floor 30 → 92 features; zoom 10 → floor 0 →
  7 features. "Zoom in for more" behaves as §6 intended.
- **Clusters carrying their top event's identity is the right call.** At world zoom the map
  reads as coloured bubbles by dominant category rather than undifferentiated grey counts.
- **The no-article state is common, not exceptional.** The first pin clicked at random
  (Barbès attack, 1941) had no English article — consistent with the measured 59.5% coverage.

### Co-location confirmed as a genuine dead end

Flying to the US Capitol at zoom 14 shows one cluster of 30 State of the Union addresses.
Clicking it zooms to `maxZoom` and supercluster then stops clustering, emitting all 30 as
individual points on the identical pixel: the header reads "30 shown", the map shows one pin,
and there is no way to reach 29 of them. Predicted in §13, now reproducible.

**Consequence for §6**: cluster click cannot always be "zoom to expansion". When
`getClusterExpansionZoom` returns `maxZoom` and the children share a coordinate, the click must
open the list/spider instead. That check belongs in the click handler, not the render path.

---

## 15. Milestone 3 findings (timeline)

Draggable window on a non-linear axis, with density histogram, width presets, edge-resize,
keyboard nav, and domain clamping. All verified against the running app.

### The non-linear axis is not a nicety — it is the whole control

Measured allocation across the curated corpus, linear versus sqrt-weighted:

| era | events | linear share | sqrt share |
|---|---|---|---|
| 3000–1000 BCE | 11 | **49.8%** | 0.9% |
| 1800–1900 | 2,712 | 1.7% | 13.5% |
| 2000–2030 | 4,772 | **0.5%** | 17.9% |

Linear would hand half the axis to 11 events and half a percent to 4,772. Confirms §5.1.

Side effect: the compressed early eras make tick labels collide (3000 BCE and 1000 BCE sit
0.9% apart). Tick *lines* are always drawn; label text is thinned to a minimum 5% gap, with
the final tick always kept so the axis states where it ends.

### Performance: one real problem, one measurement trap

**Real:** index rebuild dominates a scrub, and §5.2's claim that live scrubbing is
"affordable precisely because data is local" was **false as written**. Rebuilding over an
18,594-event window cost 88–97ms, far past a frame budget, and `useDeferredValue` cannot
rescue it — a single synchronous `index.load()` is not interruptible mid-render.

Fixed by **banding index depth to the map's zoom** (`indexDepthFor`). Supercluster builds one
KD-tree per zoom level, and at world zoom the deep trees are never queried:

| index maxZoom | build (19,668 events) |
|---|---|
| 4 | 20.9 ms |
| 8 | 29.5 ms |
| 16 | 96.8 ms |

A 4.6× cut, **semantically lossless** — the depth band is always kept above the query zoom,
since querying above an index's `maxZoom` returns unclustered points and would dump every raw
point on the map. Total app work per window change is now ~25ms at the worst case
(filter 1.1 + byQid 2.8 + index 20.9 + getClusters 0.2).

**Rejected along the way:** filtering by rank floor *before* indexing is ~13× cheaper
(600 events / 7ms at world zoom) but makes cluster counts report only notable events —
it collapsed Europe's 1900–1950 bubble from 472 to 16 and destroyed the density signal the
map exists to convey. The floor hides *pins*, never clusters, per §6.

**The trap:** scrub benchmarks in the preview pane measured ~1000ms frames, which looked like
an app problem. It was not. Twelve *pure* `triggerRepaint()` calls — no React, no data, no
clustering — exceeded 30 seconds. The pane software-rasterizes WebGL, so **frame-rate and
interaction-latency numbers taken there are meaningless.** Only the JS timings above are
trustworthy. Real-device feel remains unverified and is the open question for this milestone.

### Fixed while testing

`setPointerCapture` throws for a pointer id the browser has no active record of, which aborted
the drag handler entirely. Now wrapped: losing capture merely degrades the drag, whereas
throwing lost it completely.

### Verified behaviours

- Drag preserves window **width in years**, not in screen fraction — sliding a 50-year window
  from 1900 back to 1603 keeps it 50 years, rather than silently widening in compressed eras.
- Edge handles resize; both domain ends clamp with width preserved; further dragging is a no-op.
- Presets (decade / century / millennium) re-centre on the current window's midpoint.
- Keyboard: arrows step a quarter-window, shift+arrow a full window.

### Revision: window sizing has two modes (from user feedback)

The first cut always preserved window width **in years**, which fought the sqrt axis instead
of using it. Corrected to two explicit modes, with **Free as the default**:

- **Free** — the window holds a constant width **on screen**; its span in years stretches as
  it moves into compressed early eras. This is the payoff of §5.1: because the axis is
  weighted by sqrt(event count), constant screen width means roughly *constant event density
  in view*. Measured, dragging the default window backwards:

  | position | range | span | events in window |
  |---|---|---|---|
  | start | 1900 — 1950 | 50 y | 2,582 |
  | mid | 1464 — 1784 | 320 y | 2,207 |
  | deep | 100 — 1267 | **1,167 y** | 1,184 |

  A 23× growth in years keeps the event count within roughly a factor of two, instead of the
  near-empty map that a fixed 50-year window shows in antiquity.

- **Decade / Century / Millennium** — span locked in years, for strictly comparable slices.

Presets were previously impossible to leave. Now there are three ways out: a **Free** button,
**clicking the active preset again** to toggle it off, and **dragging either edge handle** —
a hand-set edge is by definition no longer "a century", so it releases the lock automatically.
The header states the active mode (`100 years · fixed width, adaptive span`).

Track-click and keyboard navigation both follow the active mode: fraction-space steps in Free,
year-space steps under a preset.

---

## 16. Milestone 4 findings (detail panel, summaries, co-located events)

Panel with five states, baked summary store, live fallback, CC BY-SA attribution, and the
co-located event list. All verified in the browser.

### Wikidata descriptions close most of the no-article gap

`schema:description` added to the harvest (+3× query cost, absorbed by adaptive chunking):

| | |
|---|---|
| description coverage | **93.7%** (18,395 / 19,627) |
| events with no English article | 4,465 (22.7%) |
| ...of those, now carrying a description | **82.0%** — rescued from a blank panel |
| ...still blank | 803 (4.1% of corpus) |

**Correction to §7 and the milestone 4 plan:** the no-article figure is ~23%, not the 40%
quoted earlier. 40.5% was measured on the *raw* corpus; curation had already removed junk
types that disproportionately lacked articles.

Events lacking an English article often have several in other languages — Battle of Stonne
has 10 sitelinks (fr, it, ru, pl, he…) and none in English. But in the *curated* corpus only
76 such events carry rank ≥ 5, so a non-English fallback would rescue few. Description was
the right fix; language fallback stays low priority.

### Non-deterministic categorisation (fixed)

Items carry multiple `P31` types and the OPTIONAL join returns one row each; `normalize` kept
the first and discarded the rest. Adding an unrelated `?desc` OPTIONAL reordered results and
moved **~6,400 events between categories**. The defect was not the sports leaking back in —
it was that curation stopped being reproducible across harvests, which is the one property the
allowlist depends on. `t` is now `number[]` and curation decides over the whole set, with
inclusion beating exclusion. Result beats the pre-bug baseline on every axis:

| | before (one type) | after (all types) |
|---|---|---|
| kept | 19,668 | **20,410** |
| correctly excluded | 17,695 | **17,943** |
| unreviewed | 5,318 | **4,334** |

### Prefetch: a sampling error worth remembering

A 150-event sample ran at **150/s**, and that was extrapolated to "all 15,000 in ~100 seconds".
The real run took **3,064s and failed 5,236 of 15,758 requests with HTTP 429.**

Top-ranked articles are warm in Wikimedia's CDN edge cache; the long tail is not, and cache
misses reach origin, which rate-limits hard. **Sampling the most popular items measures the
cache, not the service.** Compounded by a 1–2s backoff and six workers retrying in lockstep.

Now: concurrency 2, 120ms per-worker spacing, `Retry-After` honoured, exponential backoff with
jitter over 5 attempts, and — most importantly — **resume**, so a partial run tops up instead
of refetching and re-triggering the limit. Resume also preserves any `syn` narrative already
attached to a record.

### Sitelink integrity

`wikibase_item` in the response is checked against the event's QID. Over 15,758 attempts:
**0 outright 404s, 181 QID mismatches (1.15%)** — e.g. "Boer Wars" (Q1676845) whose sitelink
resolves to Q6857636. So stale sitelinks are not mainly renamed pages but *ambiguous* ones,
and without this check we would have baked the wrong article under those events.

### Store shape

Sharded by `qid % 64`, manifest-driven so the client never guesses or probes. At 10,340
summaries: **5.83 MB raw / 2.01 MB gzipped**, ~93 KB raw / 32 KB gzipped per shard — one
fetch answers a click and covers many later ones.

`BakedSummary.syn` is reserved for synthesized narrative and is deliberately a **separate
field** from the Wikipedia extract, so sourced and generated prose stay distinguishable all
the way to the renderer.

### Co-located events

Cluster click tests whether all members share an **identical** coordinate — not whether the
expansion zoom is exhausted. Zoom cannot separate points that are not apart. Partial overlap
resolves itself: a mixed cluster zooms, the stack forms its own cluster further in, and that
one opens the list. The Capitol's 30 State of the Union addresses are now all reachable.

### Dropped deliberately

§7's `sessionStorage` cache for live results. With the baked store covering everything with an
article, live fetches are the rare path and a second cache layer earns little.
