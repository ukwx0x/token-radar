// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// every pre-token protocol below the watchlist floor that passes the watchlist's own visible rule.
// At or above the floor only watchlist slugs rank: the watchlist encodes the parent-protocol check
// the snapshot does not carry, so a protocol the house left out at that size stays out. A protocol
// is pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol);
// the snapshot's live-token protocols are kept apart and shown as the market's own values, never
// mixed into the ranked board. They also calibrate the model: see calibrateMultiples.
//
// Implied value follows only from the snapshot's own figures:
//
//   ratio      = mcap_usd / tvl_usd for each live-token protocol, winsorized to [0.05, 2.00]
//   market     = median ratio over all live-token protocols
//   multiple   = (n x category median + 5 x market) / (n + 5), or market when the category
//                has no live protocol; small categories are pulled toward the market median,
//                and the pull weakens as more live protocols set the category
//   base       = tvl_usd x multiple
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   breadth    = 1 + 0.05 x min(chains - 1, 4)            (more chains, more reach, at most +20%)
//   implied    = max(1, round(base x growthMult x maturity x breadth))
//
// The constants are stated in the dashboard and changeable in the model sandbox. No protocol name
// is ever special-cased: the same function scores every row.

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

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_step: number;
  breadth_max_extra_chains: number;
  shrinkage_k: number;
  multiple_floor: number;
  multiple_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_step: 0.05,
  breadth_max_extra_chains: 4,
  shrinkage_k: 5,
  multiple_floor: 0.05,
  multiple_cap: 2.0,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's calibration: its median ratio, its shrunk multiple, and how many live protocols set it. */
export interface CategoryCalibration {
  median: number;
  multiple: number;
  n: number;
}

/** The calibration: the market median and quartiles, and each category's own shrunk multiple. */
export interface Calibration {
  global_multiple: number;
  global_n: number;
  global_p25: number;
  global_p75: number;
  categories: Record<string, CategoryCalibration>;
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
    multiple: number;
    category_median: number | null;
    category_n: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  watchlist: boolean;
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
  multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
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
  multiple: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
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
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted array of numbers; the mean of the two middle values when its length is even. */
function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A quantile of a sorted array, linearly interpolated between its two nearest values. */
function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * The shrunk multiple for one category: its median ratio blended with the market median, as if
 * `k` extra protocols at the market median voted with the category's own `n`. A category with one
 * live protocol is pulled hard toward the market; a category with many keeps its own median.
 */
export function shrunkMultiple(median: number, n: number, global: number, k: number): number {
  return round4((n * median + k * global) / (n + k));
}

/**
 * Calibrate the value multiple from the snapshot's own live-token protocols: each one's
 * market-cap-to-TVL ratio, winsorized to the model's floor and cap so one outlier never sets a
 * median, then the median per category, shrunk toward the whole market's median. Categories with
 * no live protocol use the market median, and the dashboard says so for each row.
 */
export function calibrateMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX');
  const winsor = (x: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, x));
  const all = live.map((p) => winsor(p.mcap_usd! / p.tvl_usd)).sort((a, b) => a - b);
  const global_multiple = round4(medianOf(all));
  const global_p25 = round4(quantileOf(all, 0.25));
  const global_p75 = round4(quantileOf(all, 0.75));
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = byCategory.get(key) ?? [];
    list.push(winsor(p.mcap_usd! / p.tvl_usd));
    byCategory.set(key, list);
  }
  const categories: Record<string, CategoryCalibration> = {};
  for (const key of [...byCategory.keys()].sort()) {
    const ratios = byCategory.get(key)!.sort((a, b) => a - b);
    const median = round4(medianOf(ratios));
    categories[key] = { median, multiple: shrunkMultiple(median, ratios.length, global_multiple, model.shrinkage_k), n: ratios.length };
  }
  return { global_multiple, global_n: live.length, global_p25, global_p75, categories };
}

/** The multiple one category scores at: its own shrunk calibration, or the market median. */
export function multipleFor(category: string | null, calibration: Calibration): number {
  const entry = calibration.categories[category ?? 'Other'];
  return entry === undefined ? calibration.global_multiple : entry.multiple;
}

/** The four multipliers and the implied value one protocol gets under `model` and `calibration`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  calibration: Calibration,
): { implied: number; multiple: number; categoryMedian: number | null; categoryN: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const entry = calibration.categories[protocol.category ?? 'Other'];
  const multiple = entry === undefined ? calibration.global_multiple : entry.multiple;
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_max_extra_chains);
  const breadthMult = 1 + model.breadth_step * extraChains;
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * breadthMult));
  return { implied, multiple, categoryMedian: entry === undefined ? null : entry.median, categoryN: entry === undefined ? 0 : entry.n, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the watchlist rule keeps out: wrapped, staked, bridged and exchange products. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Names beginning with an exchange's name are that exchange's product, not a protocol of its own. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** A whole word wrapped, staked or staking in a name marks a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token and not a wrapped, staked, bridged or exchange product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, calibration: Calibration = calibrateMultiples(snapshot, model)): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor. At or above the
  // floor the watchlist alone decides, since it encodes the parent-protocol check the snapshot
  // does not carry. Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, calibration);
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
      multiple: s.multiple,
      category_median: s.categoryMedian,
      category_n: s.categoryN,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A category's farm playbook: the core action, a second action, the weekly cadence, the hold rule
 * and the unwind. Templates take %N% (name), %C% (capital with $) and %H% (first chain). The
 * dashboard carries the same table, so the plan on the page is the plan board.json carries.
 */
interface Playbook {
  core: string;
  second: string;
  weekly: string;
  hold: string;
  exit: string;
}

const PLAYBOOKS: Record<string, Playbook> = {
  lend: {
    core: "Supply %C% of USDC to %N% on %H% and keep the position open.",
    second: "Borrow 30% of the supply in a stablecoin and hold the borrow, keeping the health factor above 2.0.",
    weekly: "Check the borrow rate and the health factor, and top up the supply if the factor falls toward 1.5.",
    hold: "Keep the health factor above 2.0 the whole time.",
    exit: "repay the borrow first, then withdraw the supply",
  },
  dex: {
    core: "Provide %C% of liquidity to %N%'s main pool on %H% and keep the position open.",
    second: "Set a concentrated range around the current price so the position earns fees instead of sitting idle.",
    weekly: "Collect the fees and move the range only when the price has left it.",
    hold: "Leave the range in place between rebalances.",
    exit: "remove the liquidity in one transaction and keep the fee receipts",
  },
  vault: {
    core: "Deposit %C% of USDC into %N%'s highest-TVL vault on %H% and keep the shares.",
    second: "Read the vault strategy note and confirm what the shares hold before adding more.",
    weekly: "Check the share price and the vault deposits, and add only when the strategy is unchanged.",
    hold: "Keep the shares and do not hop vaults each week.",
    exit: "redeem the shares in one transaction and keep the receipt",
  },
  perp: {
    core: "Deposit %C% of USDC as margin on %N% and open one small hedge, no more than 2x leverage.",
    second: "Set a stop that caps the loss on the hedge at $10 and leave it alone.",
    weekly: "Check the funding rate and the margin ratio, and close the hedge if funding runs against it for a full week.",
    hold: "Keep the hedge small. Size, not leverage, is what counts.",
    exit: "close the hedge first, then withdraw the margin",
  },
  bridge: {
    core: "Bridge %C% of USDC to %H% through %N% and use the bridged funds in its app.",
    second: "Make one swap or deposit with the bridged funds on %H% so the route is used, not just opened.",
    weekly: "Bridge a small amount back or onward so the route sees activity in both directions.",
    hold: "Keep some funds on %H% for the full window.",
    exit: "bridge the funds back in one transaction and keep both receipts",
  },
  stake: {
    core: "Stake %C% of the chain's staking asset through %N% and keep the receipt token.",
    second: "Check the unbonding period and write down the earliest date the stake can leave.",
    weekly: "Check the rewards accrual and confirm the stake is still delegated.",
    hold: "Do not unstake early. The unbonding wait restarts the clock.",
    exit: "unstake once, wait out the unbonding period, then withdraw",
  },
  stable: {
    core: "Mint or deposit %C% of the stable asset through %N% on %H%.",
    second: "Provide the stable asset to %N%'s main pool so it is used, not just held.",
    weekly: "Check the peg and the reserves note, and reduce the position if the peg slips more than 1%.",
    hold: "Keep the peg check weekly. A slipped peg is the exit signal.",
    exit: "redeem the stable asset back to USDC in one transaction",
  },
  rwa: {
    core: "Mint %C% of the protocol's yield asset on %H% and hold it.",
    second: "Complete the eligibility check the protocol publishes, if it requires one, before adding more.",
    weekly: "Check the accrual and the redemption window so a lockup never surprises you.",
    hold: "Note the redemption window before the hold starts.",
    exit: "redeem through the published window and keep the confirmation",
  },
  basis: {
    core: "Deposit %C% into a delta-neutral basis position on %N% and hold it through one funding cycle.",
    second: "Read the funding history and confirm the position stays hedged on both legs.",
    weekly: "Check the funding rate and the hedge ratio, and rebalance only when the ratio drifts.",
    hold: "Hold through full funding cycles. Single days mislead.",
    exit: "close both legs together, then withdraw",
  },
  prediction: {
    core: "Fund %C% and place one market position on %N%.",
    second: "Pick a market that resolves inside the hold window so the position settles while you watch it.",
    weekly: "Check the open markets and add one small position only when a market you understand opens.",
    hold: "Never chase a market you cannot explain.",
    exit: "let the position resolve, then withdraw the balance",
  },
  insurance: {
    core: "Buy %C% of cover from %N% on %H% and keep the policy.",
    second: "Read what the cover excludes, and write down the claim window and the proof it needs.",
    weekly: "Check the policy is still active and the covered protocol is still listed.",
    hold: "Keep the policy active for the full window.",
    exit: "let the cover expire or cancel it through the published flow, and keep the policy file",
  },
  launchpad: {
    core: "Commit %C% to an allocation on %N% and complete its participation steps.",
    second: "Finish every task the allocation lists, and keep each confirmation.",
    weekly: "Check the allocation status and the next sale date so no window is missed.",
    hold: "Keep the commitment staked for the full window.",
    exit: "claim or withdraw through the published flow once the window closes",
  },
  nft: {
    core: "Mint or buy %C% of the collection on %N% and hold it.",
    second: "List nothing for sale in the first month. Holding is the signal being farmed.",
    weekly: "Use the app or game once a week so the wallet shows activity, not just a balance.",
    hold: "Keep the item held for the full window.",
    exit: "sell or transfer through the published marketplace, and keep the sale receipt",
  },
  payment: {
    core: "Route %C% of payments through %N% on %H% and keep the receipts.",
    second: "Set one recurring payment through %N% so the volume repeats without manual work.",
    weekly: "Check the receipts match the amounts sent, and fix any failed route the same week.",
    hold: "Keep the recurring payment running for the full window.",
    exit: "stop the recurring payment, then withdraw any balance",
  },
  privacy: {
    core: "Deposit %C% through %N%'s privacy pool on %H% and keep the note.",
    second: "Withdraw a small test amount first to confirm the note works before the full deposit ages.",
    weekly: "Check the pool anonymity set is still large enough to use.",
    hold: "Keep the note offline for the full window.",
    exit: "withdraw through the published flow and destroy any note copy you no longer need",
  },
  ai: {
    core: "Stake or deposit %C% into %N%'s compute or agent pool on %H% and keep the position open.",
    second: "Run one job or task through the pool so the stake is used, not just held.",
    weekly: "Check the job volume and the stake rewards, and add only when volume is steady.",
    hold: "Keep the stake in the pool for the full window.",
    exit: "unstake through the published flow and keep the receipt",
  },
  index: {
    core: "Buy %C% of the index token on %N% and hold it.",
    second: "Read the index weights and confirm no single asset dominates the basket.",
    weekly: "Check the rebalance note and the token price against the basket.",
    hold: "Hold through at least one rebalance.",
    exit: "sell the index token in one transaction and keep the receipt",
  },
  locker: {
    core: "Lock %C% of tokens through %N% for the shortest term it offers.",
    second: "Confirm the unlock date and write it down before the lock starts.",
    weekly: "Check the lock is still recorded and the unlock date is unchanged.",
    hold: "Never lock longer than the hold window.",
    exit: "unlock on the recorded date and keep the confirmation",
  },
  chain: {
    core: "Bridge %C% to the chain through %N% and use its core apps for a week.",
    second: "Use two core apps on the chain, such as its main exchange and its main lending market.",
    weekly: "Use one core app each week so the wallet stays active on the chain.",
    hold: "Keep funds on the chain for the full window.",
    exit: "bridge the funds back and keep both receipts",
  },
  liquidity: {
    core: "Deposit %C% into a %N% managed liquidity vault on %H% and keep the shares.",
    second: "Check which pools the vault routes to and confirm the fees it charges.",
    weekly: "Check the share price and the vault pool list for changes.",
    hold: "Keep the shares for the full window.",
    exit: "redeem the shares and keep the receipt",
  },
  default: {
    core: "Deposit %C% of USDC into %N% on %H% and keep the position open.",
    second: "Make a second, different action in the app, such as a swap, a vote or a second deposit.",
    weekly: "Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.",
    hold: "Keep the position open for the full window.",
    exit: "withdraw in one transaction and keep the receipt",
  },
};

/** The playbook key for a category. Order matters: index before dex (Indexes holds dex), bridge and stake before chain. */
export function playbookKey(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option') || c.includes('futures')) return 'perp';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lend';
  if (c.includes('index')) return 'index';
  if (c.includes('dex') || c.includes('swap') || c.includes('amm')) return 'dex';
  if (c.includes('staking') || c.includes('restak')) return 'stake';
  if (c.includes('stable')) return 'stable';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('basis')) return 'basis';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('launchpad')) return 'launchpad';
  if (c.includes('nft') || c.includes('gaming') || c.includes('game')) return 'nft';
  if (c.includes('yield') || c.includes('vault') || c.includes('aggregator') || c.includes('curator') || c.includes('allocator')) return 'vault';
  if (c.includes('payment')) return 'payment';
  if (c.includes('privacy')) return 'privacy';
  if (c.includes('agent') || c.includes('decentralized ai')) return 'ai';
  if (c.includes('locker')) return 'locker';
  if (c.includes('chain')) return 'chain';
  if (c.includes('liquidity')) return 'liquidity';
  return 'default';
}

/** Fill a playbook template with the protocol's name, capital and first chain. */
function fill(template: string, name: string, capital: number, chain: string): string {
  return template.split('%N%').join(name).split('%C%').join(`$${capital}`).split('%H%').join(chain);
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

/** Gas for one transaction on a chain: Ethereum mainnet costs more than every other chain here. */
function gasFor(chain: string): { setup: number; weekly: number; first: string } {
  if (chain === 'Ethereum') return { setup: 12, weekly: 5, first: 'under $5 of gas' };
  return { setup: 3, weekly: 1, first: 'under $1 of gas' };
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age, seven-day growth), never from a
 * hand-written list of names. No step claims the protocol runs a points program: the claim step
 * checks whether one is published, from a link the protocol itself publishes.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const chain2 = p.chains.length > 1 ? p.chains[1]! : null;
  const capital = capitalFor(p);
  const half = Math.max(25, Math.round(capital / 2));
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const pb = PLAYBOOKS[playbookKey(p.category)]!;
  let weeklyText = fill(pb.weekly, p.name, capital, chain);
  const growth = p.change_7d;
  if (growth !== null && growth >= 20) {
    weeklyText = `TVL rose ${growth.toFixed(1)}% in 7 days, so start this week: ${weeklyText.charAt(0).toLowerCase()}${weeklyText.slice(1)}`;
  } else if (growth !== null && growth <= -15) {
    weeklyText = `TVL fell ${Math.abs(growth).toFixed(1)}% in 7 days, so keep the position small: ${weeklyText.charAt(0).toLowerCase()}${weeklyText.slice(1)}`;
  }
  let secondText = fill(pb.second, p.name, capital, chain);
  let secondCost = `about $${gas.weekly} of gas on ${chain}`;
  if (chain2 !== null) {
    secondText += ` Repeat the core position on ${chain2} with $${half} so both deployments count.`;
    secondCost = `$${half} more capital, about $${gas.weekly} of gas on ${chain} and about $${gasFor(chain2).setup} of gas on ${chain2}`;
  }
  const claimText =
    `Check whether ${p.name} publishes a points or rewards page, and open it only from a link the protocol itself publishes. Never pay a fee to claim.` +
    (age !== null && age < 180 ? ' Recheck monthly: young protocols change their rules fast.' : '');
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `${gas.first} for the first transaction`,
      time: '5 minutes',
    },
    {
      text: fill(pb.core, p.name, capital, chain),
      cost: `$${capital} of capital and about $${gas.setup} of gas on ${chain}`,
      time: '15 minutes to set up',
    },
    { text: secondText, cost: secondCost, time: '10 minutes' },
    {
      text: weeklyText,
      cost: `about $${gas.weekly} of gas a week on ${chain}`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot. ${fill(pb.hold, p.name, capital, chain)}`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    { text: claimText, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    {
      text: `Write the wallet, the dates and every transaction in a farm log, and plan the unwind before you need it: ${pb.exit}.`,
      cost: 'nothing but the log',
      time: '5 minutes',
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
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: string[]): RadarRow {
  return {
    rank: row.rank,
    watchlist: watchlist.includes(row.slug),
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
    multiple: row.model.multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrateMultiples(snapshot, model);
  const board = buildBoard(snapshot, model, calibration);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => radarRow(r, snapshot.watchlist)),
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
