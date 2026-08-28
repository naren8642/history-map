/**
 * Curated allowlist of P31 "instance of" types that count as historical events.
 *
 * WHY AN ALLOWLIST: sitelink rank measures modern media attention, not
 * historical significance — unfiltered, the corpus is topped by Olympic Games
 * and is 22% machine-generated solar eclipse records. Rank tuning cannot fix
 * that; only type curation can. P31 coverage is 99.2%, so this is practical.
 *
 * THE FAILURE MODE IS SILENT OMISSION. An allowlist drops anything it doesn't
 * know about without complaint. `curate.ts` therefore reports every excluded
 * type ranked by volume, so growing this list is driven by evidence rather
 * than guesswork. Treat that report as the to-do list for expanding it.
 */

export type Category =
  | 'conflict'
  | 'atrocity'
  | 'terrorism'
  | 'politics'
  | 'natural-disaster'
  | 'accident'
  | 'nuclear'
  | 'culture'
  | 'other';

/** QIDs grouped by the category they map to. Labels are the en Wikidata label. */
const GROUPS: Record<Category, ReadonlyArray<readonly [number, string]>> = {
  conflict: [
    [178561, 'battle'],
    [188055, 'siege'],
    [1261499, 'naval battle'],
    [198, 'war'],
    [645883, 'military operation'],
    [831663, 'military campaign'],
    [2001676, 'offensive'],
    [476807, 'military raid'],
    [350604, 'armed conflict'],
    [180684, 'conflict'],
    [997267, 'skirmish'],
    [678146, 'bombardment'],
    [19841484, 'sack'],
    [680838, 'ambush'],
    [124734, 'rebellion'],
    [4688003, 'aerial bombing of a city'],
    [2380335, 'airstrike'],
    [111034471, 'missile strike'],
    [30588142, 'drone warfare'],
    [1384277, 'military expedition'],
    [6539177, 'aircraft shootdown'],
    [467011, 'invasion'],
    // Third pass, from the rank-weighted dropped-event report:
    [7883019, 'undeclared war'],
    [2659056, 'colonial war'],
    [8465, 'civil war'],
    [1323212, 'insurgency'],
    [830494, 'dogfight'],
    [273976, 'blockade'],
    [104708121, 'storming'],
    [6107280, 'revolt'],
    [23036198, 'hostage-rescue mission'],
    [194465, 'annexation'],
  ],
  atrocity: [
    [3199915, 'massacre'],
    [6983405, 'Nazi crime'],
    [177716, 'pogrom'],
    [750215, 'mass murder'],
    [486775, 'lynching'],
    [66307429, 'place of mass murder'],
    [17164849, 'police brutality in the United States'],
    [137909331, 'killing by law enforcement officers'],
  ],
  terrorism: [
    [2223653, 'terrorist attack'],
    [891854, 'bomb attack'],
    [18493502, 'suicide bombing'],
    [217327, 'suicide attack'],
    [20893947, 'suicide car bombing'],
    [25917154, 'truck bombing'],
    [21480300, 'mass shooting'],
    [473853, 'school shooting'],
    [136281265, 'university shooting'],
    [109217482, 'shooting attack'],
    [18711682, 'vehicle-ramming attack'],
    [6813020, 'stabbing attack'],
    [61039291, 'knife attack'],
    [1371150, 'hostage taking'],
    [898712, 'aircraft hijacking'],
    [318296, 'kidnapping'],
    [3882219, 'assassination'],
    [88178910, 'assassination attempt'],
    // Surfaced by the expansion report: this class holds the assassination of
    // Archduke Franz Ferdinand. Omitting it would have left WWI without a cause.
    [5510053, 'fusillade'],
    [25917186, 'coordinated terrorist attack'],
    [134693479, 'attack on church'],
    [930164, 'conspiracy'],
  ],
  politics: [
    [131569, 'treaty'],
    [625298, 'peace treaty'],
    [45382, "coup d'état"],
    [25906438, "attempted coup d'état"],
    [29102902, 'papal election'],
    [273120, 'protest'],
    [124757, 'riot'],
    [175331, 'demonstration'],
    // Kept deliberately: 174 of these stack on the US Capitol, which makes
    // them the test case for the co-located-pin interaction.
    [554211, 'State of the Union address'],
    [6934728, 'multilateral treaty'],
    [3588250, 'ethnic riot'],
    [861911, 'oration'],
    [1227249, 'international incident'],
    [28966115, 'G7 summit'],
    [7888355, 'United Nations Climate Change Conference'],
    [111161, 'synod'],
    [51645, 'ecumenical council'],
    [1464916, 'declaration of independence'],
    [727002, 'charter'],
    [116741026, 'constitutive treaty'],
    [9557810, 'bilateral treaty'],
    [11122, 'treaty of the European Union'],
    [16567729, 'Council of Europe treaty'],
    [1414472, 'international human rights instrument'],
    [1646218, 'international environmental agreement'],
    [107706, 'armistice'],
    [7157512, 'peace conference'],
    [1072326, 'summit'],
    [625994, 'convention'],
    [18603729, 'dissolution of an administrative territorial entity'],
    [1140229, 'political union'],
    [5791104, 'international crisis'],
    [1572600, 'proclamation'],
    [2751586, 'resolution'],
    [3771738, 'historical document'],
    [125506609, 'LGBT+ protest'],
    [85785387, 'migrant crisis'],
  ],
  'natural-disaster': [
    [7944, 'earthquake'],
    [7692360, 'volcanic eruption'],
    [8068, 'flood'],
    [8081, 'tornado'],
    [169950, 'wildfire'],
    [167903, 'landslide'],
    [7935, 'avalanche'],
    [60186, 'meteorite'],
    [3839081, 'disaster'],
    [8070, 'tsunami'],
    [727990, 'megathrust earthquake'],
    [7446977, 'off Sanriku earthquake'],
    [11639848, 'multi-segment earthquake'],
    [114041309, 'earthquake sequence'],
    [131136, 'meteor'],
  ],
  accident: [
    [744913, 'aviation accident'],
    [3002150, 'aircraft crash'],
    [26975538, 'airplane crash'],
    [1863435, 'mid-air collision'],
    [47487415, 'ditching'],
    [3149875, 'aviation incident'],
    [1078765, 'railway accident'],
    [1331380, 'derailment'],
    [11396408, 'train collision'],
    [906512, 'shipwrecking'],
    [2620513, 'maritime disaster'],
    [2235325, 'maritime accident'],
    [168983, 'conflagration'],
    [838718, 'city fire'],
    [7625093, 'structure fire'],
    [179057, 'explosion'],
    [1362483, 'gas explosion'],
    [68800046, 'industrial disaster'],
    [1550225, 'mining accident'],
    [1309431, 'structural failure'],
    [11620651, 'bridge failure'],
    [54643580, 'tailings dam failure'],
    [2165983, 'stampede'],
    [106673346, 'crowd crush'],
    [19689353, 'pilot suicide'],
    [30880545, 'sinking'],
    [116673853, 'ground collision'],
    [977367, 'chemical accident'],
    [220187, 'oil spill'],
    [3193890, 'environmental disaster'],
    [327541, 'arson'],
    [106955175, 'passenger flight'],
  ],
  nuclear: [
    [210112, 'nuclear weapons testing'],
    [3058675, 'underground nuclear weapons test'],
    [98607365, 'atmospheric nuclear test'],
    [4367188, 'underwater nuclear explosion'],
    // Chernobyl and Fukushima. Their absence is what prompted the rank-weighted
    // report: a singleton type holding the corpus's third-ranked event never
    // rose high enough on a volume-ordered list to be noticed.
    [15725976, 'nuclear disaster'],
  ],
  culture: [[172754, "world's fair"]],
  /**
   * Wikidata's generic event containers. Low precision by nature, but they hold
   * genuine history that has no more specific class — the Boston Tea Party is
   * an "incident". Kept, and leaned on the rank floor to control the noise.
   */
  other: [
    [1190554, 'occurrence'],
    [12890393, 'incident'],
    [13418847, 'historical event'],
    [11827304, 'historical process'],
  ],
};

/**
 * Types excluded on purpose, so the curate report can distinguish "we decided
 * against this" from "we have not looked at this yet". Without it, every run
 * would re-surface eclipses at the top of the to-do list.
 */
export const DELIBERATELY_EXCLUDED = new Map<number, string>([
  [5681048, 'partial solar eclipse — astronomical, machine-generated'],
  [5691927, 'annular solar eclipse — astronomical, machine-generated'],
  [11086064, 'total solar eclipse — astronomical, machine-generated'],
  [28339417, 'hybrid solar eclipse — astronomical, machine-generated'],
  [27020041, 'sports season'],
  [114609228, 'recurring sporting event edition'],
  [26132862, 'Olympic sports discipline event'],
  [18536594, 'Olympic sporting event'],
  [47345468, 'tennis tournament edition'],
  [47403752, 'tennis tournament edition by gender'],
  [46190676, 'tennis event'],
  [16510064, 'sporting event'],
  [13406554, 'sports competition'],
  [51031626, 'sport competition at a multi-sport event'],
  [167170, 'multi-sport event'],
  [1539532, 'sports season of a sports club'],
  [26895936, 'American football team season'],
  [130387189, 'rugby league team season'],
  [27787439, 'film festival edition'],
  [110288240, 'Eurovision Song Contest edition'],
  [110372546, 'Junior Eurovision Song Contest edition'],
  [4504495, 'award ceremony'],
  [115915867, 'film award ceremony edition'],
  [27308988, 'César Awards ceremony'],
  [24569309, 'Tony Awards ceremony'],
  [47505518, 'AVN Awards ceremony'],
  [2992372, 'gunshot — individual crime, 0 events above rank 10'],
  [132821, 'murder — individual crime'],
  [149086, 'homicide — individual crime'],
  [4676786, 'deliberate murder — individual crime'],
  [81672, 'attempted murder — individual crime'],
  [9687, 'traffic collision'],
  [61037771, 'car collision'],
  [24871403, 'bus accident'],
  [7833114, 'tram accident'],
  [19710423, 'level crossing collision'],
  [244404, 'electrical injury'],
  [193840, 'asphyxia'],
  [4, 'death'],
  [24231964, 'Wikipedia:Meetup — project-space noise'],
  [17633526, 'Wikinews article — project-space noise'],
  [219423, 'mural'],
  [464980, 'exhibition'],
  [59861107, 'temporary art exhibition'],
  [896958, 'Landesgartenschau'],
  [1656682, 'planned event'],
  [18340514, 'events in a specific year or time period'],
  // Second pass, from the expansion report:
  [506424, 'UCI Road World Championships'],
  [2954514, 'European Road Cycling Championships'],
  [101246533, 'rally edition'],
  [622521, 'NBA draft'],
  [137592217, 'Winter Olympic Games edition'],
  [107540719, 'UEFA European Championship edition'],
  [17315159, 'international association football match'],
  [65770283, 'association football final'],
  [109623729, 'association football club match'],
  [1413606, 'World Rowing Championships'],
  [140678780, 'chess tournament edition'],
  [130192067, 'Olympic Games opening ceremony'],
  [94998068, 'Olympic Games closing ceremony'],
  [27968055, 'recurring event edition'],
  [139554557, 'recurring religious event edition'],
  [136819118, 'television award ceremony edition'],
  [40728071, 'UFO sighting'],
  [2252077, 'shooting — individual crime'],
  [135976384, 'Summer Olympic Games edition'],
  // Third pass:
  [1478437, 'association football competition'],
  [178750, 'Copa América'],
  [12708896, 'final of the FIFA World Cup'],
  [111072137, "edition of the FIFA Women's World Cup"],
  [80716240, 'UEFA Champions League final'],
  [14547231, 'international sporting event'],
  [3327913, 'Summer Paralympic Games'],
  [138028979, 'Summer Youth Olympic Games edition'],
  [270163, 'tennis at the Summer Olympics'],
  [114581, 'ice hockey at the Olympic Games'],
  [11783626, 'athletics meeting'],
  [2122052, 'qualification event'],
  [89031984, 'cancelled music event due to the COVID-19 pandemic'],
  [3887, 'solar eclipse — astronomical, machine-generated'],
  [8082, 'Malaysian Grand Prix'],
  [7980, 'Chinese Grand Prix'],
  // Objects and abstractions, not events: they appear only as secondary types
  // on items whose real classification is elsewhere.
  [42314054, 'ammunition model'],
  [15142894, 'weapon model'],
  [176799, 'military unit'],
  [1406161, 'artistic theme'],
  [22087155, 'end cause'],
  [183366, 'territory'],
  [47461344, 'written work'],
  [3497659, 'articles of association'],
]);

export const ALLOWED: ReadonlyMap<number, Category> = new Map(
  Object.entries(GROUPS).flatMap(([category, entries]) =>
    entries.map(([qid]) => [qid, category as Category] as const),
  ),
);

export const TYPE_LABELS: ReadonlyMap<number, string> = new Map(
  Object.values(GROUPS).flatMap((entries) => entries.map(([qid, label]) => [qid, label] as const)),
);

export const CATEGORIES = Object.keys(GROUPS) as Category[];

/**
 * Which category wins when an event carries allowlisted types from several.
 *
 * Without an explicit order, "first match wins" inherits the order of the
 * harvest's result rows — the same order-dependence that made categorisation
 * irreproducible before. It showed up immediately: Chernobyl is both an
 * `environmental disaster` and a `nuclear disaster`, and landed under
 * "accident" purely because that row arrived first.
 *
 * Ordered most-specific first. The generic containers sit last so that
 * `incident` or `occurrence` never beats a precise classification.
 */
export const CATEGORY_PRECEDENCE: readonly Category[] = [
  'nuclear',
  'atrocity',
  'terrorism',
  'natural-disaster',
  'conflict',
  'accident',
  'politics',
  'culture',
  'other',
];

/** The winning category among an event's types, or undefined if none match. */
export function categoryFor(types: readonly number[]): Category | undefined {
  let best: Category | undefined;
  let bestRank = Infinity;
  for (const t of types) {
    const category = ALLOWED.get(t);
    if (!category) continue;
    const rank = CATEGORY_PRECEDENCE.indexOf(category);
    if (rank >= 0 && rank < bestRank) {
      best = category;
      bestRank = rank;
    }
  }
  return best;
}
