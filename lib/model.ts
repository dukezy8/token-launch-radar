// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every
// other pre-token protocol that passes the exclusion rules below: the clean universe the radar
// exists to find. A protocol is pre-token when its index entry records no token (no market cap,
// no CoinGecko id, no symbol); the snapshot's live-token protocols are kept apart and shown as the
// market's own values, never mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures, and the multiple is earned, not
// assumed: each category's multiple is the median FDV/TVL of the live-token protocols in that same
// category (ratios winsorized to [0.02, 3.0], categories with fewer than three live comps fall back
// to the market-wide median), clamped to [0.05, 1.0]. A lending protocol is therefore scored at the
// lending market's own multiple, not at a flat house number, and a basis-trading protocol at the
// basis market's.
//
//   categoryMultiple = median of winsorized FDV/TVL over the category's live comps (n >= 3),
//                      else the market-wide median, clamped to [0.05, 1.0]
//   growth           = clamp(change_7d, -50, 100) per cent
//   growthMult       = 1 + (growth / 100) x 0.6
//   maturity         = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   chainsMult       = 1 + 0.02 x min(chains - 1, 5)
//   implied          = max(1, round(tvl_usd x categoryMultiple x growthMult x maturity x chainsMult))
//
// No protocol name is ever special-cased: the same functions score every row, and the dashboard
// prints the multiple table so the ranking can be checked line by line.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_cap: number;
  winsor_min: number;
  winsor_max: number;
  multiple_min: number;
  multiple_max: number;
  min_comps: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_cap: 5,
  winsor_min: 0.02,
  winsor_max: 3.0,
  multiple_min: 0.05,
  multiple_max: 1.0,
  min_comps: 3,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's multiple: how many live comps set it, their median ratio, the multiple used. */
export interface CategoryMultiple {
  category: string;
  live_comps: number;
  median_ratio: number | null;
  multiple: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chains_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan carried along so the page shows
 * exactly the steps board.json carries, never a second copy of the generator. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chains_multiplier: number;
  is_watchlist: boolean;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  fdv_tvl: number | null;
}

/** Everything the dashboard needs: the board, the live set, the model and its multiples. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  categories: CategoryMultiple[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or null when it is empty. */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A name that is itself a wrapped or staked derivative of an issued token. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Categories that are derivatives of an already-issued token rather than protocols of their own:
 * bridges move another chain's token, liquid staking and restaking wrap a staked token, and a
 * stablecoin wrapper wraps an issued stablecoin. A protocol in one of these is a derivative, not a
 * launch candidate, whatever its name says.
 */
const DERIVATIVE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Stablecoin Wrapper',
]);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool,
 * not a wrapped or staking derivative by name, and not in a derivative category.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    p.category !== 'CEX' &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    (p.category === null || !DERIVATIVE_CATEGORIES.has(p.category))
  );
}

/**
 * Every category's multiple from the snapshot's own live-token protocols: the median of the
 * winsorized FDV/TVL ratios where the category has enough comps, else the market-wide median.
 * The table covers the categories the board actually uses, so the dashboard can print it whole.
 */
export function categoryMultiples(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { byCategory: Map<string, number>; table: CategoryMultiple[]; global: number } {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    // A zero market cap is a dead or delisted token, not a comp: only a live market value sets a multiple.
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0 || p.category === null || p.category === 'CEX') continue;
    const ratio = Math.min(model.winsor_max, Math.max(model.winsor_min, p.mcap_usd / p.tvl_usd));
    allRatios.push(ratio);
    const list = ratiosByCategory.get(p.category) ?? [];
    list.push(ratio);
    ratiosByCategory.set(p.category, list);
  }
  allRatios.sort((a, b) => a - b);
  const globalMedian = medianOf(allRatios) ?? 0.25;
  const global = Math.min(model.multiple_max, Math.max(model.multiple_min, globalMedian));
  const boardCategories = new Set<string>();
  for (const p of snapshot.protocols) {
    if (isRankable(p) && p.category !== null) boardCategories.add(p.category);
  }
  const byCategory = new Map<string, number>();
  const table: CategoryMultiple[] = [];
  for (const category of [...boardCategories].sort()) {
    const ratios = (ratiosByCategory.get(category) ?? []).sort((a, b) => a - b);
    const median = medianOf(ratios);
    const multiple =
      ratios.length >= model.min_comps && median !== null
        ? Math.min(model.multiple_max, Math.max(model.multiple_min, median))
        : global;
    byCategory.set(category, multiple);
    table.push({ category, live_comps: ratios.length, median_ratio: median, multiple });
  }
  return { byCategory, table, global };
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiples: Map<string, number>,
  globalMultiple: number,
  model: ModelConstants = MODEL,
): {
  implied: number;
  categoryMultiple: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainsMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainsMult = 1 + model.chain_step * Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_cap);
  const categoryMultiple =
    protocol.category !== null && multiples.has(protocol.category)
      ? multiples.get(protocol.category)!
      : globalMultiple;
  const implied = Math.max(
    1,
    Math.round(protocol.tvl_usd * categoryMultiple * growthMult * maturityMult * chainsMult),
  );
  return { implied, categoryMultiple, growthPct, growthMult, maturityMult, chainsMult, age };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
  mults: { byCategory: Map<string, number>; global: number } = categoryMultiples(snapshot, model),
): BoardRow[] {
  const { byCategory, global } = mults;
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The clean universe: every other protocol that passes the exclusion rules. No TVL cap, no
  // count cap: a radar that stops at an arbitrary row count is not a radar.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, byCategory, global, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: round4(s.categoryMultiple),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chains_multiplier: round4(s.chainsMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('uncollateralized'))
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm'))
    return `Deposit $${capital} into ${name}'s main vault on ${chain} and keep the shares.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('manager'))
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('chain') && !c.includes('bridge')) return `Bridge $${capital} of USDC onto ${name} and hold it in a native app on the chain.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index token on ${chain} and hold it.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('liquidity manager')) return `Deposit $${capital} into a ${name}-managed liquidity position on ${chain}.`;
  if (c.includes('governance')) return `Deposit $${capital} and vote in one ${name} governance round on ${chain}.`;
  if (c.includes('payment') || c.includes('card')) return `Fund $${capital} through ${name} on ${chain} and make one payment with it.`;
  if (c.includes('otc')) return `Place one $${capital} trade through ${name} on ${chain}.`;
  if (c.includes('btc')) return `Deposit $${capital} of BTC value through ${name} on ${chain} and hold the receipt.`;
  if (c.includes('cedefi')) return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The second qualifying action: a second chain when the protocol spans one, else a second verb. */
function secondAction(p: SnapshotProtocol, capital: number): string {
  if (p.chains.length > 1) {
    const second = p.chains[1]!;
    return `Repeat the core action on ${second} with $${Math.max(25, Math.floor(capital / 2))} so the activity spans two chains.`;
  }
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Borrow $10 against the supply and repay it within the week, so the wallet shows both sides of the market.`;
  if (c.includes('dex')) return `Swap $10 through the pool once, so the wallet shows a trade as well as liquidity.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis') || c.includes('farm'))
    return `Deposit a second, smaller tranche of $25 two weeks later, so the activity reads as a returning user.`;
  if (c.includes('derivative')) return `Close the hedge and open one fresh small position, so the wallet shows repeat use.`;
  if (c.includes('prediction')) return `Settle one market and place a second position, so the wallet shows repeat use.`;
  return `Make one more qualifying action, such as a deposit, a swap or a vote, two weeks after the first.`;
}

/** The weekly cadence verb for the category. */
function weeklyVerb(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'a supply top-up, a borrow or a repayment';
  if (c.includes('dex')) return 'a swap or a liquidity rebalance';
  if (c.includes('derivative')) return 'one small hedged trade';
  if (c.includes('prediction')) return 'one market position';
  if (c.includes('governance')) return 'a vote or a forum post';
  if (c.includes('insurance')) return 'a policy check or a claim review';
  return 'a deposit, a swap or a vote';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. Multi-chain protocols get a second-chain step; every plan ends with a claim check and a
 * log, because a farm nobody can unwind is a loss, not a position.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondAction(p, capital),
      cost: p.chains.length > 1 ? `about $${Math.max(25, Math.floor(capital / 2))} of capital and $4 of gas` : 'about $2 of gas',
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as ${weeklyVerb(p)}, so the wallet stays active across snapshots.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; then write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'no fee to check, and never pay to claim',
      time: '15 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      fdv_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? Math.round((p.mcap_usd / p.tvl_usd) * 1000) / 1000 : null,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chains_multiplier: row.model.chains_multiplier,
    is_watchlist: watchlist.has(row.slug),
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const mults = categoryMultiples(snapshot, model);
  const board = buildBoard(snapshot, model, mults);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: mults.global,
    categories: mults.table,
    rows: board.map((r) => radarRow(r, watchlist)),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
