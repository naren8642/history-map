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
6. **Narrative layer + full corpus** — `P580/P582` spans, `P361` containment, story-first
   map. See §19; this milestone was redefined after milestone 5.
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

`wikibase_item` in the response is checked against the event's QID. Across both runs:
**0 outright 404s, 462 QID mismatches (2.9%)** — and notably the rate is higher in the
low-ranked tail (5.2%) than at the top (1.15%), so ambiguity tracks obscurity — e.g. "Boer Wars" (Q1676845) whose sitelink
resolves to Q6857636. So stale sitelinks are not mainly renamed pages but *ambiguous* ones,
and without this check we would have baked the wrong article under those events.

### Store shape

Sharded by `qid % 64`, manifest-driven so the client never guesses or probes.

Final store: **15,473 summaries — 98.2% of articled events, 75.8% of the whole corpus.**
8.67 MB raw / **2.95 MB gzipped**; ~138 KB raw / **47 KB gzipped per shard**, so one fetch
answers a click and covers many later ones. 70% carry a thumbnail.

The top-up run under the corrected settings had **zero failures** (5,133 fetched in 1,559s),
against 5,236 failures in the first attempt.

Combining baked summaries with Wikidata descriptions, **only 959 events (4.7%) have no prose
at all** — name, date and category only.

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

---

## 17. Rank-weighted curation report, and the holes it found

### The report was asking the wrong question

`curate.ts` ranked unreviewed types by how many notable events each contained. That answers
*"which gap is widest?"* but never *"what is the most important thing we are dropping?"* —
and those diverge badly when a singleton type holds one irreplaceable event.

**The Chernobyl disaster — rank 125, third in the entire corpus — was not on the map.** Its
type `nuclear disaster` held one event, so it sorted far below Formula One seasons and never
surfaced. `nuclear weapons testing` was in the taxonomy; `nuclear disaster` had simply never
been added.

A second report now lists the highest-ranked *dropped events* with the unrecognised types
responsible. It immediately exposed far more than the handful already known:

```
125  1986  Chernobyl disaster            environmental disaster, nuclear disaster
122  1776  US Declaration of Independence declaration of independence
111  1945  Charter of the United Nations  charter, constitutive treaty
 93  1982  Falklands War                  undeclared war
 92  2011  Tohoku earthquake and tsunami  tsunami, megathrust earthquake
 90  1991  dissolution of the Soviet Union dissolution of an admin. territorial entity
 85   325  First Council of Nicaea        ecumenical council
 77  1938  Anschluss                      annexation
 77  1940  Battle of Britain              dogfight
 74  1969  Stonewall riots                LGBT+ protest
 73  2011  Fukushima Daiichi nuclear disaster  nuclear disaster
```

Taxonomy grew from 90 to 156 allowed types and 47 to 90 explicit exclusions. Kept rose
19,627 → **20,660**, unreviewed fell 4,334 → **4,082**. The curated top now opens with
Chernobyl, the Declaration of Independence, and the UN Charter.

**Generalisation:** any filter needs a report ordered by *importance*, not only by *volume*.
Volume-ordered lists are dominated by the uninteresting bulk, which is exactly where a
singleton catastrophe hides.

### Category precedence (a second order-dependence)

With multiple allowlisted types per event, "first match wins" reintroduced the §16 bug in
miniature: Chernobyl is both an `environmental disaster` and a `nuclear disaster` and landed
under **accident** purely because that row came first. `CATEGORY_PRECEDENCE` now orders
categories most-specific first, so generic containers (`incident`, `occurrence`) can never
beat a precise classification. Chernobyl and Fukushima became *nuclear*, Katyn *atrocity*,
and the Boston Tea Party moved from *other* to *politics*.

### Co-location: the test was too strict

§16 opened the group list when cluster members shared an *identical* coordinate. Too narrow.
The Chernobyl disaster and the Chernobyl Mi-8 helicopter crash sit **~30 m apart** — not
identical, so the list never opened, yet they still cluster at maximum zoom and the click
silently did nothing.

The rule is now whether the cluster's **expansion zoom exceeds the map's maximum**, which is
the literal question: *is there any zoom on this map that separates these?* Exact co-location
is retained only to word the panel accurately ("share one coordinate" vs "too close together
to separate at any zoom level").

### Known minor inefficiency

The 286 events whose sitelink fails the QID check are retried on every prefetch run, costing
roughly a minute. Caching negative results would fix it.

---

## 18. Milestone 5 findings (density), driven by a real-hardware recording

Everything before this was measured in a software-rasterised preview pane, which could show
*what* rendered but never *how it looked*. An 11-second screen recording on real hardware
exposed two problems that no amount of headless probing would have surfaced.

### Cluster colour was lying about composition

Clusters inherited the **top-ranked member's** category — a milestone 2 decision made so the
label could read "Battle of Waterloo +47". The colour came along with it, unexamined.

Measured over Europe, 1900–1950: **52.8% of clusters were painted a category that was not
their majority.** One 25-event cluster read as `politics` where politics was 12% of it and
conflict 48%. On screen, Europe looked blue-and-teal while the legend said Conflict 1,145
against Politics 119. The map was making a false claim about its own contents.

Fixed by accumulating **category counts** through the reduce and colouring by the modal
category, while the label still names the most notable member — the two questions get two
answers instead of one answer serving both. Agreement with the true majority rose from
47.2% to **88.3%**; the residual are exact ties, broken by an explicit precedence order
rather than by object iteration order (the same determinism trap as §16 and §17).

### Cluster overlap was arithmetic, not misfortune

Supercluster's radius was **55px** while bubble radii scaled to **38px — a 76px diameter**.
Any cluster past a couple of hundred points was drawn wider than the spacing that separated
it, so collisions were guaranteed by construction. Radius is now 90 and the bubble ramp caps
at 30 (60px diameter), safely inside it.

### Zoom was the wrong input for the notability floor

Measured over central Europe, the old zoom-tied floor produced:

```
zoom 2.7  floor 30   2,127 in view   110 drawn
zoom 5    floor  7   1,078 in view   149 drawn   <- peak crowding
zoom 7.5  floor  2      33 in view    18 drawn   <- cliff
```

Crowded through the mid zooms, barren above them. Zoom does not determine legibility: what
matters is how many events are in view, which depends on zoom *and* window width *and*
regional density — and the first design ignored two of the three.

Replaced with a **feature budget** (`FEATURE_BUDGET = 90`). Clusters are never dropped, since
a cluster is the only evidence that anything is there; the remaining budget goes to the most
notable loose points, and the effective floor falls out of the data instead of being dictated
to it. After:

| zoom | before | after |
|---|---|---|
| 2.7 | 110 | **79** |
| 4.1 | 102 | 60 |
| 5 | **149** | **83** |
| 6 | 106 | 75 |
| 7.5 | 18 | **24** |

The remaining drop at 7.5 is data-limited rather than policy-limited — only 33 events exist
in that view. The budget also self-tunes: milestone 6 can triple the corpus without anyone
retuning a threshold table.

### Method note

Two of these three were invisible to every check run so far. The preview pane could confirm
that 110 features existed; it could not show that they overlapped, nor that their colours
misrepresented them. **A rendering pipeline needs to be seen rendering.**

---

## 19. Milestone 6, redefined: the narrative layer

**Goal (from the user):** *"I look at Europe in the 1940s and there are hundreds of individual
events, but what we want is the story of WW2 — showcase the large events that affected the
course of humanity, and present individual events in the context of the bigger picture."*

### The finding that reframed the milestone

**World War II was not in the corpus at all.** Not filtered out — never harvested. We took only
`P585` (point in time), and wars carry `P580`/`P582`. The map held hundreds of WWII's battles
and not the war. Every "bigger picture" object was missing for the same reason.

Measured against Wikidata:

| | |
|---|---|
| 1939–46 geolocated events with a `P361` parent | **47.1%** (63.9% among span events) |
| pointing directly at World War II | **239** |
| WWII / Pacific War / Eastern Front / Holocaust coordinates | **none — a war is not a point** |
| WWII sitelink rank | **291**, above any single event in the corpus |
| containment shape | **a DAG** — the Second Sino-Japanese War is part of both WWII *and* the Pacific War |

### Model: two kinds of object

- **Event** — a point in space and time. What we have.
- **Narrative** — a *span* in time, a *set* of members, and **no intrinsic location**. Its
  geography is derived: a convex hull of every event beneath it, plus a centroid to anchor
  the label.

Narratives cannot be discovered by the harvest queries, which are anchored on `P625`; a
narrative has no coordinates, so no geo query can reach it. They are instead discovered
*from their children* — an event names its parents, and `scripts/narratives.ts` resolves that
set and walks **up** the DAG until it reaches roots.

Resolution uses SPARQL `VALUES` batches, not an aggregate: grouping over all of `P361` times
out on WDQS, while asking about 200 known QIDs at a time is fast and predictable.

Both the descent (collecting member points) and the depth calculation guard against cycles,
which do occur in Wikidata, and treat multiple parents as normal rather than exceptional.

### Chosen design

- **Story-first map.** Zoomed out shows narratives; expanding one reveals sub-narratives, then
  individual events. Events are reached through their context.
- **Region hulls.** A narrative draws as a soft hull over its members' extent — truthfully
  showing that WWII spanned Europe, North Africa and the Pacific, rather than pretending it
  occurred at a centroid in the eastern Mediterranean.
- **Story bands on the timeline.** Major narratives render as horizontal bars across the years
  they span, making the shape of history legible and offering a second way to select one.

### Known risk

`P361` coverage is 47% in the WWII era and will be far thinner for antiquity. The story layer
will be rich for modern conflict and sparse for the Bronze Age, so the map must degrade to the
event layer gracefully rather than appear broken. Orphan events — the 53% with no parent —
need a first-class home, not a fallback that looks like an error.

### The Eurocentrism measurement, and what it changed

Asked whether the map would end up Eurocentric, the honest answer was yes. Measured on the
event corpus:

| region | all events | pre-1500 |
|---|---|---|
| Europe | 43.3% | **83.7%** |
| Africa | 4.8% | 15 events |
| Lat. America | 4.1% | 5 events |
| N. America | 21.4% | 3 events |
| Oceania | 1.9% | 0 |

**A first reading blamed the pipeline and was wrong.** Comparing our counts against raw
Wikidata suggested we were losing ~95% of the non-European record — but those raw totals were
inflated by solar eclipses. Like for like, 0–1500 CE with eclipses removed:

```
Europe      2,581 in Wikidata   1,657 ours   64% captured
Africa         55 in Wikidata      13 ours   24% captured
N. America     15 in Wikidata       3 ours   20% captured
Lat. America   12 in Wikidata       5 ours   42% captured
```

**81.8% of what Wikidata holds for 0–1500 is European.** We amplify it (24% capture in Africa
against 64% in Europe) but did not create it. Africa has *fifty-five* geolocated dated events
for the whole period. Filtering better cannot fix that.

**The record exists — it is just not stored as events.** Every major non-European polity is in
Wikidata, dated, mostly with coordinates, at ranks rivalling anything in the corpus:

```
Mongol Empire 142   Inca Empire 135   Gupta Empire 116   Mali Empire  99
Khmer Empire   82   Aksum        76   Srivijaya    69   Songhai      64
Kush           63   Cahokia      54   Aztec Empire 44   Benin Empire 44
```

For scale, Chernobyl is 125 and Waterloo 93. Harvesting only *events* fishes in the one pond
where the imbalance is worst. So the polities pass serves both goals at once — it is the
story layer the narrative milestone needs, and it is where non-European history lives.

Result: **pre-1500 Europe falls from 83.7% to 71.1%**, with the Inca Empire, Qing dynasty,
Indus Valley Civilization, Achaemenid and Sasanian Empires, Cultural Revolution and Korean War
now present. Still Europe-heavy — that is Wikidata, and the honest response is to say so in
the UI rather than to pretend otherwise.

### Milestone 6 data layer: results

```
instants (P585)   43,023 events   30.7% with a P361 parent
spans (P580/582)  33,943 events   43.6% with a P361 parent
polities            1,446 items   63.1% with own coordinates
narratives          2,807         1,251 roots, 1,121 with hulls, max depth 6
```

World War II now exists, with **1,462 events beneath it**. Also the Cold War (522), French
Revolution (732), American Civil War (608), Crusades, Vietnam War, Korean War.

Four traps found while building it:

- **`country` (Q6256) admits modern states.** The United States arrived as a "narrative" at
  rank 427 with the span "1784–1784", outranking every real story node. Dropped, along with
  `city-state`, which admits Berlin, Vienna, Hong Kong and Macau.
- **27% of polities have no end date.** The end is left equal to the start and flagged `o`,
  rather than extended to the present — extending would assert that Cahokia is still going.
- **Deep time leaks in.** `historical period` includes the Phanerozoic (538 million BCE) and
  Cenozoic (66 million BCE); one such record would flatten the timeline axis. Anything ending
  before the domain is dropped, anything merely starting earlier is clipped.
- **Narratives need curating too.** They are discovered through `P361`, which the event
  allowlist never touches, so FIFA World Cups and Eurovision arrived as top-ranked story nodes.
  622 excluded by type; ~35 series editions still leak, which is why the build now prints its
  top 40 narratives as an explicit review list — the §17 lesson applied again.

---

## 20. Data maintenance and extension

Until now the pipeline could be *run* but not *maintained*: no refresh cadence, no way to see
what a re-run changed, and no answer to "why isn't X on the map?" other than ad-hoc scripting.

### `npm run explain` — the diagnostic

Traces one item through every stage and reports where it was lost:

```
npm run explain -- "Berlin Conference"
npm run explain -- Q1379
```

It checks Wikidata first (coordinates? date? types? parents? rank?), then each harvest file,
then curation, then the shipped artefacts, and names the likely cause. This exists because the
same question kept recurring — the Chernobyl disaster, third-ranked in the corpus, was absent
for weeks — and each time was answered by hand.

Its first real use found the **1884 Berlin Conference**, which partitioned Africa, being
dropped for the unrecognised type `international conference`.

### Extending: two routes, and a rule for choosing

**A class of events → fix the taxonomy.** `international conference` was not a one-off; adding
it to `GROUPS` fixed the Berlin Conference and everything like it. Prefer this route.

**A genuine one-off → `data/manual/curation.json`.**

```jsonc
{
  "include": [{ "q": 13582, "g": "politics", "why": "..." }],  // force-keep
  "exclude": [{ "q": 999,   "why": "..." }],                   // force-drop
  "patch":   { "1379": { "c": [30.1, 51.4] } },                // fix a field
  "add":     [ /* events the harvest cannot reach at all */ ]  // e.g. no P625
}
```

Every entry requires a `why`; a year later that is the only thing making an override
reviewable. Use the real QID even for `add`, so summaries and narrative links still resolve.

**The file should stay small.** A large override file means the allowlist is wrong, and
overrides are invisible to every measurement the pipeline reports.

### Regression diff

`curate` writes a snapshot each run and reports the delta against the previous one: total
change, and every event above rank 20 that was present before and is gone now.

This exists because **silent loss is this pipeline's characteristic failure**, twice over: a
truncated HTTP response dropped an entire decade while the run exited 0, and the span pass was
harvested for a whole milestone before anyone noticed curation never read its file — 33,943
events collected and discarded. Both were found by accident. Now the build says it out loud.

### Refresh cadence (planned, not yet built)

- **Monthly** `npm run data`. Wikidata churns steadily; the measured sitelink staleness of
  2.9% is the drift this corrects.
- **Fail CI on a nonzero harvest `PROBLEMS` count.** Already reported, still not enforced.
- **Fail CI on unexplained notable losses** from the regression diff.
- **Surface data age in the UI** — the manifest already carries `generated`.

### Known upkeep costs

- The 286 events whose sitelink fails the QID check are retried every prefetch run (~1 min).
  Caching negative results would fix it.
- Both the event allowlist and the narrative exclusions need periodic review as Wikidata adds
  types. The two review reports (`EXPANSION CANDIDATES`, `MOST NOTABLE DROPPED EVENTS`) and
  the narrative top-40 list are the intended way to do that, not manual browsing.

---

## 21. Cluster peek: reaching an article without drilling

**Feedback:** *"As I drill down on the consolidated pins it takes several clicks to get to the
final zoom level where I can access the article popup. Can we add a hover popup listing the
article titles under the pin, so I can expand that article directly?"*

Reaching text cost a multi-click descent through zoom levels. That cost only grows with the
narrative layer, where a story hull can sit three levels above the article wanted — so the
peek was built **before** hulls, and the narrative layer will reuse it rather than inventing
its own drill-down.

### Behaviour

- **Hover a cluster** → card listing its top 8 members by rank, plus "+N more".
- **Click a title** → that article's detail panel. One hover, one click, from world zoom.
- **Click the cluster** → full scrollable list of every member, with "Zoom to these".

Clicking a cluster no longer zooms. Zoom remains on double-click, scroll, the map controls,
and the panel's explicit action — but it is no longer the toll for reading something.

### Revised after use: the card is passive

The first version made the card's titles clickable. In practice that failed: leaving the
cluster fires MapLibre's `mouseleave`, and the card only survived if the pointer crossed the
18px gap of bare map before a grace period expired. Reaching a title was a race the user had
to win, and usually lost.

Two structural faults behind it. The card was rendered **inside the container MapLibre owns**,
so React and MapLibre were both mutating one node's children. And an interactive card must
capture pointer events, which means it can steal the very hover it depends on.

Now the card is **passive** — `pointer-events: none`, no buttons, ending in "click to open" —
and lives in a wrapper beside the map rather than inside it. Leaving the cluster closes it
immediately, with no grace period, because leaving genuinely means leaving.

Nothing is lost: clicking the cluster opens the same list as a real panel, so reaching an
article is two clicks and no zooming. The card only ever needed to answer *"what is in here?"*.

**The general lesson:** an interactive hover surface has to solve the reach problem, and the
reach problem has no clean solution when the trigger is a small target on a map. Making the
surface passive removes the problem instead of managing it.

### Two details that would have broken it

**`getLeaves` returns tree order, not rank order.** The first five members of a 1,532-event
cluster were ranks 8, 15, 5, 1, 7. Taking the first eight would have shown near-random obscure
events as a cluster's "most notable". The whole membership must be pulled and sorted —
measured at ~10ms for 1,532 members, against 1.6ms for a naive eight, and cached per cluster.

**The card is interactive, so the pointer has to reach it.** Closing on mouse-out would make
the titles unclickable. Opening is delayed 130ms so sweeping across clusters does not flash
cards; closing is delayed 220ms and cancelled when the pointer enters the card. Any camera
movement dismisses it, since its anchor position becomes stale.

Verified on real data: hovering Germany in 1900–1950 lists the Munich Agreement, Anschluss,
Potsdam Conference, Battle of Berlin, Beer Hall Putsch, Battle of the Bulge, Berlin Blockade
and the Reichstag fire — and the full list reads as a browsable history of the period.

---

## 22. Milestone 6 rendering: the story layer on screen

Story-first map, region hulls, and timeline bands — the three decisions from §19, built.

### What it does

Root stories overlapping the window draw as labelled anchors over the event clusters.
Entering one narrows the map to everything beneath it, recomposes the legend to that story's
own makeup, and surfaces its sub-stories on both the map and the timeline. A breadcrumb leads
back out.

Entering **World War II**: 905 events in the window, legend reading Conflict 869 / Atrocity 30,
sub-stories Winter War, 1939 Invasion of Poland, Battle of Kursk.
Clicking the **Cold War** band: window moves to 1945–1991, 318 events, sub-stories Korean War,
Vietnam War, Hungarian Revolution of 1956, Revolutions of 1989, Bangladesh Liberation War.

Membership resolves on the client. The baked file stores each narrative's parents but not its
members; events already name their parents, so the reverse index is cheaper to build at load
than to ship. Descent dedupes by QID and guards cycles — containment is a DAG, and Wikidata
does make it circular.

### Four things that only showed up on screen

**Hulls cannot all be drawn at once.** World War II's convex hull spans most of the planet —
it genuinely happened almost everywhere — and eight such fills at 7% opacity turned the map
uniformly grey while conveying nothing. Labels now advertise which stories exist; the extent
appears only for the story hovered or entered.

**MapLibre suppressed six of eight story labels** through collision with event pins, including
World War II, the most important object on the map. Story labels now ignore placement
collisions; the budget of eight keeps that from becoming clutter.

**Click priority had to become explicit.** Layer handlers raced each other, and a guard meant
to stop vast hulls swallowing pin clicks also made the World War II anchor unreachable, because
it sat beneath a 42-event cluster. A single handler now resolves in order — story anchor, then
events, then hull — because an anchor is a small deliberate target and a hull is a vast
background, and they need opposite treatment.

**Duration and importance are unrelated.** World War II's band is ~20px wide against the
Middle Ages' 186px. Clipping labels to band width left the most significant stories showing a
single character. Bands keep their honest width; narrow ones put the name beside them.

### Still open

- The label anchor is the centroid of members, which for a global story lands somewhere
  arbitrary — World War II's sits near Syria. A density-weighted anchor would read better.
- Convex hulls over scattered members overstate extent. Concave hulls, or one hull per
  geographic cluster of members, would be truer.
- Nothing yet marks how much of a period the story layer covers. In sparse regions and eras
  the map silently falls back to bare events, which is correct behaviour but reads as absence.

---

## 23. Current state and what comes next

Written as a handoff. §1–22 record how each decision was reached; this section
records where things stand and what is undecided.

### Where the project stands

Milestones 1–6 complete. `npm run data` runs the whole pipeline; `npm run dev` serves the app.

```
harvest (P585)      43,023 events        harvest (P580/P582)  33,943 events
harvest polities     1,438 items         curated events       25,431
narratives           4,042               baked summaries      19,412
```

The map leads with stories: labelled anchors over event clusters, entering one filters to its
subtree and surfaces sub-stories on both map and timeline. Hover peeks into a cluster; click
opens its full list. The timeline carries a non-linear axis, a free/fixed-width window, and
story bands.

### Decided but not yet built: LLM synthesis

Chosen direction. The design as agreed:

**Never let the model produce URLs.** A fabricated authoritative-looking citation is worse
than none. Two verified sources instead:
- **Wikidata's curated external IDs** — confirmed present on our narratives: Encyclopædia
  Britannica, Polish PWN, Norwegian Lex, Google Knowledge Graph. Human-curated, free.
- **Claude's server-side `web_search` / `web_fetch`** — these *retrieve*, so their URLs are
  real rather than recalled.

**The prerequisite is a story panel, not the hull fix.** Entering a story currently changes
only a breadcrumb; there is nowhere for prose to live. Panel shape: title and span, then a
visually distinct **generated overview** labelled as such, then sub-stories, then **Sources**.
Generated text sits above in reading order and below in visual weight, so cited material stays
primary — the same rule that keeps `BakedSummary.syn` a separate field from `x`.

**Synthesis does not replace the coverage signal — it raises the stakes.** A fluent paragraph
about the Mali Empire beside an empty map reads as *"this is covered"*. And thin-record history
is where a model's recall is weakest and the reader's ability to check is lowest. The panel
should state what it was written from: *"from 3 events in this dataset; the record for West
Africa in this period is thin."*

Cost at Opus 5 rates (~2k input / 350 output per narrative; ~9k input with search):

| scope | count | no search | with search |
|---|---|---|---|
| all | 4,042 | ~$76 | ~$220 |
| ≥5 events beneath | ~800 | ~$15 | ~$44 |
| top 500 by rank | 500 | ~$9 | ~$28 |

> **Wrong by about 8×. Measured figures in §25.** This table costed a single API
> call. What runs is an agentic loop whose turns resend accumulated context.

**Undecided: which scope.** Recommendation was ≥5 events with web search, or 20 hand-picked
first to judge tone and accuracy before committing.

### Decided but not yet built: Vital Articles discovery

Our discovery is Wikidata-shaped — "what has coordinates, a date, and an allowlisted type?"
A topic with an excellent Wikipedia article that fails any gate is invisible. **496 polities
have no coordinate at all**: Tang dynasty, Vikings, Maya civilization, Great Depression.

Wikipedia's **Vital Articles** hierarchy is a human-curated importance ranking that is *not*
biased toward things that happen to have coordinates. Seeding from it inverts the question
from "what does Wikidata have?" to "what are the major topics in world history?" — and then
finding their data. Pairs naturally with synthesis, since a topic with no coordinate still has
an article and can still be placed approximately.

> **Corrected in §24.** The claim above that this reaches topics Wikidata lacks is wrong —
> it reaches no new topics at all. What it is actually worth is stated in §24.

Licensing is not the obstacle: Wikipedia text is CC BY-SA, reuse with attribution is explicit,
and we attribute on every panel. At our scale the API is fine (19,412 summaries in ~40 min);
bulk work should use Wikimedia dumps rather than slow scraping.

### Open work, roughly in priority order

1. **Story panel** — prerequisite for synthesis; nowhere for prose today.
2. **Coverage honesty** — say when a region/era is thin instead of letting absence read as fact.
3. **Synthesis pass** — scope undecided (above).
4. **Vital Articles seeding** — reaches the 496 coordinate-less polities.
5. **Story-layer defects** — label anchor is the mean of members, so World War II is labelled
   near Syria; convex hulls overstate extent, covering oceans a war never reached.
6. **Milestone 7** — URL state (shareable "WWII, 1939–45, Normandy" links), keyboard nav,
   mobile layout, empty/error states.
7. **Operational (§20, still unbuilt)** — monthly scheduled refresh; fail CI on a nonzero
   harvest `PROBLEMS` count; fail CI on unexplained notable losses from the curation diff.

### Known gaps, with numbers

- 496 polities have no Wikidata coordinate — unreachable by geographic harvest.
- ~35 recurring sports series still leak into narratives; the top-40 review list is how they
  surface. Great Zimbabwe has no date; Tang dynasty no coordinate.
- 27,324 unreviewed event types after the span pass — `EXPANSION CANDIDATES` is the to-do list.
- 286 events fail the sitelink QID check and are retried every prefetch run (~1 min wasted).
- Pre-1500 coverage is 68% Western even after the polities pass. That is Wikidata; the
  response is to say so, not to hide it.

### Recurring failure modes in this project

Worth keeping in view, because each cost real time and each recurred:

- **Silent loss.** A truncated HTTP response dropped a decade while the run exited 0. Span
  events were harvested for a whole milestone before anyone noticed curation never read their
  file. 94% of polities vanished between two stages. All three were found by accident, which
  is why `curate` now diffs against the previous run and `explain` exists.
- **Order-dependence.** Arbitrary P31 choice, arbitrary category choice, arbitrary cluster
  colour — each looked fine and each was irreproducible until an explicit precedence was added.
- **Volume-ranked reports hide singletons.** Chernobyl, third in the corpus, sat unnoticed
  under a type holding one event. Reports need an importance ordering as well as a count.
- **Only rendering reveals rendering bugs.** Cluster colours misrepresenting their contents,
  hulls greying out the map, six of eight story labels suppressed — none visible headless.
- **Shared lists with divergent meanings.** One exclusion list read by two consumers turned
  "route this elsewhere" into "drop this everywhere".


## 24. Can we source events from Wikipedia instead?

Asked directly: Wikipedia has articles for the Cholas, the Māori, the Qing — are we missing
them because they are not in Wikidata?

**No, and the premise does not hold.** 37 topics probed, weighted toward the non-European
record. **None lacked a Wikidata item.** This is structural rather than lucky: Wikidata is
what stores the interlanguage links between Wikipedia editions, so an established article
essentially always has an item. "On Wikipedia but not in Wikidata" is close to a
non-category.

Switching source would therefore have gained nothing and cost the structure the app runs on —
article titles carry no coordinates, no dates, and no types. Wikipedia supplies prose;
Wikidata supplies placement. This retires the question.

It also corrects §23: **Vital Articles is not a route to topics Wikidata is missing.** Its
value is narrower and still real — a human-curated importance ranking that does not correlate
with having coordinates, and so a better answer to "what matters" than sitelink count. Worth
doing on that basis alone, not as coverage rescue.

### What the probe found instead

14 of the 37 were absent from the app. Six of those **pass every gate** and sit correctly in
`polities.json`: Chola dynasty, Tang, Maya civilization, Qin, Zhou, the Delhi Sultanate. The
loss was downstream, at [`scripts/narratives.ts`](scripts/narratives.ts) — a narrative with no
coordinate of its own and nothing geolocated beneath it hit an unlogged `continue`.

**515 of 1,438 polities — 36% — died there.** Ranked by sitelinks: Industrial Revolution 161,
Vikings 157, Aztec 148, Maya 141, Great Depression 133, Tang 128, Qin 100, Zhou 91.

The guard itself is right; a story with no geography cannot be drawn. What was wrong is that
it was the only rejection on that loop without a counter, so a third of the corpus vanished
while the run exited 0. **Fifth instance of this shape.** See the failure modes in §23.

### `locate-polities.ts`

Wikidata does know where these are — it just does not say so with `P625`. It says so with the
capital, the location, the country. The pass follows one hop to something that carries a
coordinate and records **which edge was used**, so a derived point stays auditable.

| property | placed |
|---|---|
| `P36` capital | 276 |
| `P276` location | 84 |
| `P17` country *(flagged coarse)* | 79 |
| `P131` / `P159` / `P2341` / `P1269` | 8 |

Two deliberate refusals, both measured:

- **`P30` continent is excluded.** It places 9 more and places every one badly — the Maya
  civilization at the centroid of North America, in central Canada. A pin that wrong is worse
  than no pin, because the map renders it with the same confidence as a real one.
- **Multi-valued properties are split by direction.** Whether the values sit *inside* the
  thing or *contain* it. Several capitals average to somewhere inside the polity (Tang's
  Chang'an and Luoyang land in Tang China); several countries do not. Taking an arbitrary
  first value put the **Great Depression in Hungary**. Capitals and locations take the
  centroid; country is used only when singular. This costs 19 placements and is worth it —
  the 21 arbitrary ones included the Great Depression, the House of Habsburg and the Iberian
  Union, none of which should carry a single point.

### Result

```
polities reaching narratives     923 -> 1,328 of 1,438
narratives                     4,042 -> 4,447
placed by derivation                    447 (79 coarse)
dropped for want of geography    515 -> 128, now counted and ranked
```

The remaining 128 are largely genuine abstractions — Industrial Revolution, Paleolithic,
Mannerism, the interwar period, "modern period" — plus royal houses spanning several
countries. They now appear in a rank-ordered report at the end of the run, next to the
existing top-narratives list.

**Great Zimbabwe is a true source gap, not our bug.** It carries `archaeological site`, an
allowed type, but has *no date property at all* — no `P571`, `P580`, `P576`, `P582`. The
harvest gate is correct to drop it. It is a candidate for manual curation, not for a code fix.

### Provenance is carried, not hidden

`Narrative.via` is `'derived' | 'coarse' | undefined`. Derived anchors draw with a thinner
stroke, country-derived ones fainter still, and entering such a story states in the breadcrumb
that the location was inferred. Without this a derived point carries exactly the visual weight
of a surveyed one, and silently equating them is how a map begins asserting things the source
never said — the same concern behind the unbuilt coverage-honesty work in §23.

### Not verified

The derived-anchor styling and the breadcrumb caveat are typechecked and the data reaches the
client (331 `derived`, 74 `coarse` in the shipped file), and derived narratives do render at
correct locations — Aztec appears in southern Mexico. But the *fainter stroke* and the
*caveat text* were not confirmed on screen: the preview pane software-rasterizes and its
scroll handler times out, as recorded in §18. Confirm both on real hardware.


## 25. The synthesis harness, and what the first 20 stories cost

Built on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), authenticated with the
local Claude Code OAuth session. No API key is read or required. (If this were ever
distributed, that changes: Anthropic does not permit third parties to offer claude.ai login to
their own users without approval. A shipped version would need API keys.)

### The citation rule is enforced, not requested

§23 settled that the model never supplies a URL. A prompt asking for real URLs is a request, so
the harness checks instead:

- [`scripts/lib/agent.ts`](scripts/lib/agent.ts) records every URL appearing in any tool result
  during a run.
- [`scripts/synthesize.ts`](scripts/synthesize.ts) accepts a citation only if it is one of the
  curated links we fetched ourselves — the Wikipedia article, or Britannica via `P1417`,
  measured present on 157 of the top 200 narratives — or is in the retrieved set. Everything
  else is discarded into `rejectedUrls`.
- [`scripts/check-citations.ts`](scripts/check-citations.ts) exercises the collector offline,
  because it is the guarantee the whole design rests on and a live run cannot prove it.

**It caught one fabrication in 86 sources.** The Ottoman Empire entry cited
`en.wikipedia.org/wiki/Millet_(Ottoman_Empire)` without ever retrieving it. That article
exists — which is exactly why the check has to be mechanical rather than a plausibility read.
1.2% is low enough to be easy to miss by eye and high enough to matter across hundreds.

The harness also denies the model the repository: `WebSearch` and `WebFetch` only,
`permissionMode: 'dontAsk'`, `settingSources: []` so no CLAUDE.md reaches a prompt about
history.

### Measured cost

```
20 stories   $8.04 total   avg $0.402   median $0.429   range $0.30 – $0.50
```

Projected from that average, against the §23 estimates:

| scope | count | measured projection | §23 estimate |
|---|---|---|---|
| top 100 | 100 | $41 | — |
| top 500 | 500 | $207 | ~$28 |
| ≥5 events | 849 | $352 | ~$44 |
| all | 4,447 | $1,842 | ~$220 |

The next scope decision is a **$350 decision, not a $44 one**. Untested levers before
committing: the SDK exposes `effort` (`low`–`max`), and `maxTurns` bounds the search loop.

Two ceilings, both enforced by the SDK rather than by hoping: `$0.60` per story via
`maxBudgetUsd`, and a run budget. **The run budget was wrong on its first outing** — a `$5` run
spent `$6.21`, because checking `spent` alone let all three workers pass the gate on the last
dollar and spend a per-story ceiling each. The worst case is now reserved before dispatch and
released in `finally`.

### The output is good, and it audits the dataset

The `coverage` field was the part most likely to degenerate into boilerplate. It did not:

> World War II: *"The dataset's 312 events lean heavily toward European and Anglo-American
> military operations, so campaigns in China, Burma and the Dutch East Indies... are thinly
> represented."*

That is §19's Eurocentrism measurement, restated unprompted about our own data. Other entries
name what would not load, distinguish uncertainty from rounding, and — for the Russo-Ukrainian
war — separate *"official denials"* from *"an independent counter-record"*.

**It also found a data error.** Ancient Egypt's coverage note flagged that our Battle of
Carchemish is dated 604 BCE where the Babylonian Chronicle and most scholarship say 605 BCE.
Checked: our event carries `s: -604`, taken unchanged from Wikidata's `-0604-01-01`
(precision 9). Wikidata does not use astronomical year numbering, so that is 604 BCE — off by
one, and faithfully propagated. Worth harvesting `coverage` fields for claims like this as more
stories run; the synthesis pass doubles as a fact-check on the corpus.

### What this does not solve

**11 of the 20 have no events at all.** The Soviet Union piece is three good paragraphs that
will land on a blank map, and its own coverage note says exactly that. The prose is now ready
before the surface that holds it — so the story panel is the only thing between this work and
a reader, and it is also the fix for the 1,265 dead ends found in §24. Build it before buying
more prose: the format here (~2,700 characters of overview, ~900 of significance, ~700 of
coverage) is an untested guess, and discovering it is wrong costs $8 at this scope and $352 at
the next.


## 26. The story panel

Entering a story used to change only a breadcrumb. §24 found 1,265 stories with nothing
beneath them, and the screen recording showed what that meant: Russian Empire → Grand Duchy of
Finland → a blank map, two clicks into nothing with no explanation. The synthesized prose from
§25 had nowhere to live either. One panel answers both.

### Where it lives

Inside the top-left panel, which already answers "where am I", rather than as a second floating
card — the detail panel on the right can be open at the same time, and two cards would fight.
The panel scrolls, and is capped at `calc(100vh - 364px)` when a story is open: the legend sits
at `bottom: 172px` in the same column and was drawing over the prose. 364px clears a
ten-category legend, its worst case rather than its usual one.

### Reading order versus visual weight

The rule from §23, now implemented: **generated prose sits above in reading order and below in
visual weight.** The overview is what the reader came for, so it is first; it carries a label
("Overview written by claude-opus-5 — not a source") and is set lighter than the sources
beneath it. `StorySynthesis` keeps `overview`/`significance` separate from `sources` for the
same reason `BakedSummary` keeps `syn` apart from `x` — merge them and the renderer can no
longer tell the reader which is which.

The coverage note gets its own treatment, marked off from body prose. It is not a disclaimer to
skim: it is the only thing standing between a fluent paragraph and the impression that a story
with no events on the map is a story we have covered.

### An empty map now says so

```
No events in this dataset sit beneath this story, so the map has nothing to
show for it. That is a gap in our data, not in the history.
```

Written from the whole subtree rather than the current window — a story does not become smaller
because the timeline is looking elsewhere.

### The trail is a route, not a derived path

`trail: number[]`, outermost first. Containment is a DAG, so there is no single ancestry to
recover after the fact; recording the route taken is the only way "back" can mean what the
reader did. Re-entering a story already on the route ascends to it rather than pushing a second
copy, because cycles do occur in Wikidata. This fixes the second defect from the recording:
inside "Allied invasion of Sicily" the only control was "‹ All stories", with no way back to
World War II.

### Store layout

One file per story under `public/data/synthesis/`, plus an `index.json` of which stories have
one — deliberately *not* the QID-sharded layout the summary store uses. The access patterns
differ: summaries are clicked rapidly while scanning a cluster, so a shard covering many later
clicks pays for itself; a story is entered deliberately, one at a time, and its overview is
~5 KB. `rejectedUrls` and `costUsd` stay in `data/raw` — provenance for us, not for the reader.

### Verified on screen

Soviet Union (no events, has an overview) renders the overview and the empty-map explanation;
World War II → Second Sino-Japanese War renders the trail as `All stories › World War II`, 44
events beneath, five sub-stories, and correctly reports that no overview has been written for
it yet. Production build clean.

Known and not fixed: timeline band labels still overlap when several sub-stories share a start
year — visible with the Second Sino-Japanese War's children, all 1937.
