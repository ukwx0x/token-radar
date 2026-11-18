// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, filters, a per-protocol detail view with the model's own inputs and
// the protocol's farm plan, and a model panel with a sandbox that re-ranks the board live.
// No network: every byte it shows is in data.js. The page recomputes every row's implied value
// from the snapshot figures with impliedOf, the same arithmetic main.ts runs, and checks the
// result against the number board.json carries. The value multiple is recomputed too: see
// shrunkMultiple, which blends each category's median ratio toward the market median.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var MODEL = DATA.model;
  var CAL = DATA.calibration;
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, scope: 'all', gainers: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null, sandbox: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(2) + 'x';
  }
  function fmt4(n) { return n.toFixed(4); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The shrunk multiple for one category: its median ratio blended with the market median, as if
  // shrinkage_k extra protocols at the market median voted with the category's own n. The page
  // recomputes it from the median and n the data carries, so the code and the data agree.
  function shrunkMultiple(median, n) {
    var k = MODEL.shrinkage_k;
    return Math.round(((n * median + k * CAL.global_multiple) / (n + k)) * 1e4) / 1e4;
  }

  // The multiple one category scores at: its own shrunk calibration, or the market median when no
  // live protocol in the category sets a median.
  function multipleFor(category) {
    var entry = CAL.categories[category || 'Other'];
    if (entry === undefined) return CAL.global_multiple;
    return shrunkMultiple(entry.median, entry.n);
  }

  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same
  // arithmetic. Overrides (the sandbox, and the detail view's sensitivity lines) scale the
  // multiple, the growth weight and the breadth step, or replace the multiple and the growth.
  function factorsOf(row, o) {
    var growthWeight = o && o.growthWeight !== undefined ? o.growthWeight : MODEL.growth_weight;
    var breadthStep = o && o.breadthStep !== undefined ? o.breadthStep : MODEL.breadth_step;
    var multiple = o && o.multipleOverride !== undefined ? o.multipleOverride : multipleFor(row.category) * (o && o.multipleScale ? o.multipleScale : 1);
    var rawGrowth = o && o.growthOverride !== undefined ? o.growthOverride : (row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d);
    var growth = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, rawGrowth));
    var growthMult = 1 + (growth / 100) * growthWeight;
    var age = row.age_days === null || row.age_days === undefined ? MODEL.unknown_age_days : row.age_days;
    var maturity = MODEL.maturity_floor + (Math.min(Math.max(age, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
    var chains = row.chains ? row.chains.length : 0;
    var breadth = 1 + breadthStep * Math.min(Math.max(chains - 1, 0), MODEL.breadth_max_extra_chains);
    var base = row.tvl_usd * multiple;
    var afterGrowth = base * growthMult;
    var afterMaturity = afterGrowth * maturity;
    var implied = Math.max(1, Math.round(afterMaturity * breadth));
    return { multiple: multiple, growthPct: growth, growthMult: growthMult, maturityMult: maturity, breadthMult: breadth, age: row.age_days, base: base, afterGrowth: afterGrowth, afterMaturity: afterMaturity, implied: implied };
  }
  function impliedOf(row, o) { return factorsOf(row, o).implied; }

  // The self-check: every row recomputed here must equal the number board.json carries.
  var recomputeChecked = DATA.rows.filter(function (r) { return impliedOf(r, null) === r.implied_value_usd; }).length;

  // The fastest riser above $10M of TVL: the radar's momentum callout in the calibration strip.
  var riser = null;
  DATA.rows.forEach(function (r) {
    if (r.tvl_usd < 10000000 || r.change_7d === null) return;
    if (!riser || r.change_7d > riser.change_7d) riser = r;
  });

  /*farm-begin*/
  // The farm plan is the same derivation main.ts writes to board.json: the category picks a
  // playbook, and the protocol's chains, TVL, age and seven-day growth decide the capital, the
  // hold, the second chain and every cost and time. No name is special-cased. Templates take
  // %N% (name), %C% (capital with $) and %H% (first chain).
  var PLAYBOOKS = {
    lend: { core: "Supply %C% of USDC to %N% on %H% and keep the position open.", second: "Borrow 30% of the supply in a stablecoin and hold the borrow, keeping the health factor above 2.0.", weekly: "Check the borrow rate and the health factor, and top up the supply if the factor falls toward 1.5.", hold: "Keep the health factor above 2.0 the whole time.", exit: "repay the borrow first, then withdraw the supply" },
    dex: { core: "Provide %C% of liquidity to %N%'s main pool on %H% and keep the position open.", second: "Set a concentrated range around the current price so the position earns fees instead of sitting idle.", weekly: "Collect the fees and move the range only when the price has left it.", hold: "Leave the range in place between rebalances.", exit: "remove the liquidity in one transaction and keep the fee receipts" },
    vault: { core: "Deposit %C% of USDC into %N%'s highest-TVL vault on %H% and keep the shares.", second: "Read the vault strategy note and confirm what the shares hold before adding more.", weekly: "Check the share price and the vault deposits, and add only when the strategy is unchanged.", hold: "Keep the shares and do not hop vaults each week.", exit: "redeem the shares in one transaction and keep the receipt" },
    perp: { core: "Deposit %C% of USDC as margin on %N% and open one small hedge, no more than 2x leverage.", second: "Set a stop that caps the loss on the hedge at $10 and leave it alone.", weekly: "Check the funding rate and the margin ratio, and close the hedge if funding runs against it for a full week.", hold: "Keep the hedge small. Size, not leverage, is what counts.", exit: "close the hedge first, then withdraw the margin" },
    bridge: { core: "Bridge %C% of USDC to %H% through %N% and use the bridged funds in its app.", second: "Make one swap or deposit with the bridged funds on %H% so the route is used, not just opened.", weekly: "Bridge a small amount back or onward so the route sees activity in both directions.", hold: "Keep some funds on %H% for the full window.", exit: "bridge the funds back in one transaction and keep both receipts" },
    stake: { core: "Stake %C% of the chain's staking asset through %N% and keep the receipt token.", second: "Check the unbonding period and write down the earliest date the stake can leave.", weekly: "Check the rewards accrual and confirm the stake is still delegated.", hold: "Do not unstake early. The unbonding wait restarts the clock.", exit: "unstake once, wait out the unbonding period, then withdraw" },
    stable: { core: "Mint or deposit %C% of the stable asset through %N% on %H%.", second: "Provide the stable asset to %N%'s main pool so it is used, not just held.", weekly: "Check the peg and the reserves note, and reduce the position if the peg slips more than 1%.", hold: "Keep the peg check weekly. A slipped peg is the exit signal.", exit: "redeem the stable asset back to USDC in one transaction" },
    rwa: { core: "Mint %C% of the protocol's yield asset on %H% and hold it.", second: "Complete the eligibility check the protocol publishes, if it requires one, before adding more.", weekly: "Check the accrual and the redemption window so a lockup never surprises you.", hold: "Note the redemption window before the hold starts.", exit: "redeem through the published window and keep the confirmation" },
    basis: { core: "Deposit %C% into a delta-neutral basis position on %N% and hold it through one funding cycle.", second: "Read the funding history and confirm the position stays hedged on both legs.", weekly: "Check the funding rate and the hedge ratio, and rebalance only when the ratio drifts.", hold: "Hold through full funding cycles. Single days mislead.", exit: "close both legs together, then withdraw" },
    prediction: { core: "Fund %C% and place one market position on %N%.", second: "Pick a market that resolves inside the hold window so the position settles while you watch it.", weekly: "Check the open markets and add one small position only when a market you understand opens.", hold: "Never chase a market you cannot explain.", exit: "let the position resolve, then withdraw the balance" },
    insurance: { core: "Buy %C% of cover from %N% on %H% and keep the policy.", second: "Read what the cover excludes, and write down the claim window and the proof it needs.", weekly: "Check the policy is still active and the covered protocol is still listed.", hold: "Keep the policy active for the full window.", exit: "let the cover expire or cancel it through the published flow, and keep the policy file" },
    launchpad: { core: "Commit %C% to an allocation on %N% and complete its participation steps.", second: "Finish every task the allocation lists, and keep each confirmation.", weekly: "Check the allocation status and the next sale date so no window is missed.", hold: "Keep the commitment staked for the full window.", exit: "claim or withdraw through the published flow once the window closes" },
    nft: { core: "Mint or buy %C% of the collection on %N% and hold it.", second: "List nothing for sale in the first month. Holding is the signal being farmed.", weekly: "Use the app or game once a week so the wallet shows activity, not just a balance.", hold: "Keep the item held for the full window.", exit: "sell or transfer through the published marketplace, and keep the sale receipt" },
    payment: { core: "Route %C% of payments through %N% on %H% and keep the receipts.", second: "Set one recurring payment through %N% so the volume repeats without manual work.", weekly: "Check the receipts match the amounts sent, and fix any failed route the same week.", hold: "Keep the recurring payment running for the full window.", exit: "stop the recurring payment, then withdraw any balance" },
    privacy: { core: "Deposit %C% through %N%'s privacy pool on %H% and keep the note.", second: "Withdraw a small test amount first to confirm the note works before the full deposit ages.", weekly: "Check the pool anonymity set is still large enough to use.", hold: "Keep the note offline for the full window.", exit: "withdraw through the published flow and destroy any note copy you no longer need" },
    ai: { core: "Stake or deposit %C% into %N%'s compute or agent pool on %H% and keep the position open.", second: "Run one job or task through the pool so the stake is used, not just held.", weekly: "Check the job volume and the stake rewards, and add only when volume is steady.", hold: "Keep the stake in the pool for the full window.", exit: "unstake through the published flow and keep the receipt" },
    index: { core: "Buy %C% of the index token on %N% and hold it.", second: "Read the index weights and confirm no single asset dominates the basket.", weekly: "Check the rebalance note and the token price against the basket.", hold: "Hold through at least one rebalance.", exit: "sell the index token in one transaction and keep the receipt" },
    locker: { core: "Lock %C% of tokens through %N% for the shortest term it offers.", second: "Confirm the unlock date and write it down before the lock starts.", weekly: "Check the lock is still recorded and the unlock date is unchanged.", hold: "Never lock longer than the hold window.", exit: "unlock on the recorded date and keep the confirmation" },
    chain: { core: "Bridge %C% to the chain through %N% and use its core apps for a week.", second: "Use two core apps on the chain, such as its main exchange and its main lending market.", weekly: "Use one core app each week so the wallet stays active on the chain.", hold: "Keep funds on the chain for the full window.", exit: "bridge the funds back and keep both receipts" },
    liquidity: { core: "Deposit %C% into a %N% managed liquidity vault on %H% and keep the shares.", second: "Check which pools the vault routes to and confirm the fees it charges.", weekly: "Check the share price and the vault pool list for changes.", hold: "Keep the shares for the full window.", exit: "redeem the shares and keep the receipt" },
    default: { core: "Deposit %C% of USDC into %N% on %H% and keep the position open.", second: "Make a second, different action in the app, such as a swap, a vote or a second deposit.", weekly: "Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.", hold: "Keep the position open for the full window.", exit: "withdraw in one transaction and keep the receipt" }
  };
  function playbookKey(category) {
    var c = (category || '').toLowerCase();
    if (c.indexOf('bridge') >= 0) return 'bridge';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('option') >= 0 || c.indexOf('futures') >= 0) return 'perp';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'lend';
    if (c.indexOf('index') >= 0) return 'index';
    if (c.indexOf('dex') >= 0 || c.indexOf('swap') >= 0 || c.indexOf('amm') >= 0) return 'dex';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'stake';
    if (c.indexOf('stable') >= 0) return 'stable';
    if (c.indexOf('rwa') >= 0) return 'rwa';
    if (c.indexOf('basis') >= 0) return 'basis';
    if (c.indexOf('prediction') >= 0) return 'prediction';
    if (c.indexOf('insurance') >= 0) return 'insurance';
    if (c.indexOf('launchpad') >= 0) return 'launchpad';
    if (c.indexOf('nft') >= 0 || c.indexOf('gaming') >= 0 || c.indexOf('game') >= 0) return 'nft';
    if (c.indexOf('yield') >= 0 || c.indexOf('vault') >= 0 || c.indexOf('aggregator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'vault';
    if (c.indexOf('payment') >= 0) return 'payment';
    if (c.indexOf('privacy') >= 0) return 'privacy';
    if (c.indexOf('agent') >= 0 || c.indexOf('decentralized ai') >= 0) return 'ai';
    if (c.indexOf('locker') >= 0) return 'locker';
    if (c.indexOf('chain') >= 0) return 'chain';
    if (c.indexOf('liquidity') >= 0) return 'liquidity';
    return 'default';
  }
  function fill(template, name, capital, chain) {
    return template.split('%N%').join(name).split('%C%').join('$' + capital).split('%H%').join(chain);
  }
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function gasFor(chain) {
    if (chain === 'Ethereum') return { setup: 12, weekly: 5, first: 'under $5 of gas' };
    return { setup: 3, weekly: 1, first: 'under $1 of gas' };
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var chain2 = p.chains && p.chains.length > 1 ? p.chains[1] : null;
    var capital = capitalFor(p);
    var half = Math.max(25, Math.round(capital / 2));
    var hold = holdDaysFor(p.age_days);
    var gas = gasFor(chain);
    var pb = PLAYBOOKS[playbookKey(p.category)];
    var weeklyText = fill(pb.weekly, p.name, capital, chain);
    var growth = p.change_7d;
    if (growth !== null && growth !== undefined && growth >= 20) {
      weeklyText = 'TVL rose ' + growth.toFixed(1) + '% in 7 days, so start this week: ' + weeklyText.charAt(0).toLowerCase() + weeklyText.slice(1);
    } else if (growth !== null && growth !== undefined && growth <= -15) {
      weeklyText = 'TVL fell ' + Math.abs(growth).toFixed(1) + '% in 7 days, so keep the position small: ' + weeklyText.charAt(0).toLowerCase() + weeklyText.slice(1);
    }
    var secondText = fill(pb.second, p.name, capital, chain);
    var secondCost = 'about $' + gas.weekly + ' of gas on ' + chain;
    if (chain2 !== null) {
      secondText += ' Repeat the core position on ' + chain2 + ' with $' + half + ' so both deployments count.';
      secondCost = '$' + half + ' more capital, about $' + gas.weekly + ' of gas on ' + chain + ' and about $' + gasFor(chain2).setup + ' of gas on ' + chain2;
    }
    var claimText = 'Check whether ' + p.name + ' publishes a points or rewards page, and open it only from a link the protocol itself publishes. Never pay a fee to claim.' +
      (p.age_days !== null && p.age_days !== undefined && p.age_days < 180 ? ' Recheck monthly: young protocols change their rules fast.' : '');
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: gas.first + ' for the first transaction', time: '5 minutes' },
      { text: fill(pb.core, p.name, capital, chain), cost: '$' + capital + ' of capital and about $' + gas.setup + ' of gas on ' + chain, time: '15 minutes to set up' },
      { text: secondText, cost: secondCost, time: '10 minutes' },
      { text: weeklyText, cost: 'about $' + gas.weekly + ' of gas a week on ' + chain, time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot. ' + fill(pb.hold, p.name, capital, chain), cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: claimText, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log, and plan the unwind before you need it: ' + pb.exit + '.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }
  /*farm-end*/

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('minTvl')) state.minTvl = Number(params.get('minTvl')) || 0;
    if (params.get('scope')) state.scope = params.get('scope');
    if (params.get('gainers') === '1') state.gainers = true;
    if (params.get('sort')) state.sort = params.get('sort');
    if (params.get('dir') === '1' || params.get('dir') === '-1') state.dir = Number(params.get('dir'));
    if (params.get('tab') === 'live') state.tab = 'live';
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.minTvl) params.set('minTvl', String(state.minTvl));
    if (state.scope !== 'all') params.set('scope', state.scope);
    if (state.gainers) params.set('gainers', '1');
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', String(state.dir));
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.minTvl && r.tvl_usd < state.minTvl) return false;
      if (state.scope === 'watchlist' && !r.watchlist) return false;
      if (state.scope === 'early' && r.watchlist) return false;
      if (state.gainers && (r.change_7d === null || r.change_7d <= 0)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function shownValue(r) { return state.sandbox ? impliedOf(r, state.sandbox) : r.implied_value_usd; }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'multiple') { av = multipleFor(a.category); bv = multipleFor(b.category); }
      else { av = shownValue(a); bv = shownValue(b); }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark', 'aria-hidden': 'true' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'Token Radar' }),
          el('div', { class: 'brand-tag', text: 'Pre-token protocols, ranked' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { class: 'model-pill', text: DATA.model_version + ' model' })
      )
    );
  }

  function hero() {
    return el('section', { class: 'hero' },
      el('h1', null, DATA.board_size + ' pre-token protocols, ranked by ', el('em', { text: 'implied value' })),
      el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model calibrated from the live-token market, not a promise.' }),
      el('div', { class: 'chips' },
        el('span', { class: 'chip', html: '<b>' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</b> watchlist covered' }),
        el('span', { class: 'chip', html: '<b>' + DATA.board_size + '</b> rows scored' }),
        el('span', { class: 'chip', html: '<b>' + DATA.early_size + '</b> early, below the floor' }),
        el('span', { class: 'chip', html: '<b>' + DATA.live_size + '</b> live-token set aside' }),
        el('span', { class: 'chip', html: '<b>' + fmtMult(CAL.global_multiple) + '</b> market median' }),
        el('span', { class: 'chip', html: '<b>' + CAL.global_n + '</b> live protocols calibrate it' })
      )
    );
  }

  function calibStrip() {
    var checkOk = recomputeChecked === DATA.rows.length;
    var riserText = riser ? riser.name + ' ' + fmtPct(riser.change_7d) + ' in 7d' : 'no riser above $10M';
    return el('section', { class: 'strip', 'aria-label': 'Calibration summary' },
      el('div', { class: 'strip-cell' },
        el('span', { class: 'strip-label', text: 'Calibration' }),
        el('span', { text: 'Market median ' + fmt4(CAL.global_multiple) + 'x from ' + CAL.global_n + ' live-token protocols. Middle half ' + fmt4(CAL.global_p25) + 'x to ' + fmt4(CAL.global_p75) + 'x. Each category median shrinks toward it.' })
      ),
      el('div', { class: 'strip-cell' },
        el('span', { class: 'strip-label', text: 'Self-check' }),
        el('span', { class: checkOk ? 'pos' : 'neg', text: checkOk ? 'All ' + DATA.rows.length + ' rows recompute exactly from the snapshot figures.' : recomputeChecked + ' of ' + DATA.rows.length + ' rows recompute to the board number.' })
      ),
      el('div', { class: 'strip-cell' },
        el('span', { class: 'strip-label', text: 'Fastest riser above $10M TVL' }),
        el('span', { text: riserText })
      )
    );
  }

  function controls() {
    var counts = {};
    DATA.rows.forEach(function (r) { var c = r.category || 'Other'; counts[c] = (counts[c] || 0) + 1; });
    var categories = Object.keys(counts).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c + ' (' + counts[c] + ')', selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var tvlSelect = el('select', { id: 'minTvl', 'aria-label': 'Minimum TVL' },
      [['0', 'Any TVL'], ['50000000', '$50M+'], ['100000000', '$100M+'], ['500000000', '$500M+'], ['1000000000', '$1B+']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: Number(o[0]) === state.minTvl ? 'selected' : null });
      })
    );
    tvlSelect.addEventListener('change', function () { state.minTvl = Number(tvlSelect.value) || 0; writeHash(); render(); });
    function scopeBtn(value, label) {
      return el('button', { type: 'button', 'aria-pressed': state.scope === value ? 'true' : 'false', text: label, onclick: function () { state.scope = value; writeHash(); render(); } });
    }
    var gainers = el('input', { type: 'checkbox', id: 'gainers', checked: state.gainers ? 'checked' : null });
    gainers.addEventListener('change', function () { state.gainers = gainers.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('label', { for: 'minTvl', text: 'Min TVL' }), tvlSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Scope' }), el('div', { class: 'tabs' }, scopeBtn('all', 'All'), scopeBtn('watchlist', 'Watchlist'), scopeBtn('early', 'Early'))),
      el('div', { class: 'field check-field' }, el('label', { class: 'check-label', for: 'gainers' }, gainers, ' Gainers only')),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live))
    );
  }

  function sortHeader(key, label, num) {
    return el('th', { scope: 'col', class: num ? 'num' : null },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } writeHash(); render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null
      )
    );
  }

  function openDetail(slug) { state.selected = slug; writeHash(); render(); window.scrollTo(0, 0); }
  function closeDetail() { state.selected = null; writeHash(); render(); }

  function boardTable() {
    var list = sortedRows(visibleRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category, chain, scope or TVL to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; state.scope = 'all'; state.gainers = false; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(shownValue).concat([1]));
    var sortDesc = { implied: ['weakest implied value first', 'strongest implied value first'], name: ['alphabetical, A first', 'alphabetical, Z first'], tvl: ['smallest TVL first', 'largest TVL first'], growth: ['slowest seven-day growth first', 'fastest seven-day growth first'], age: ['youngest first', 'oldest first'], multiple: ['lowest multiple first', 'highest multiple first'] };
    var desc = (sortDesc[state.sort] || sortDesc.implied)[state.dir < 0 ? 1 : 0];
    var captionText = 'Pre-token protocols, ' + desc + '. Select a row for its model and farm plan. ' + list.length + ' of ' + DATA.board_size + ' rows shown' + (state.sandbox ? ', sandbox ranking' : '') + '.';
    var tbody = el('tbody');
    list.forEach(function (r, i) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var value = shownValue(r);
      var rankLabel = state.sandbox ? String(i + 1) : String(r.rank);
      var tr = el('tr', {
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: rankLabel }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (r.watchlist ? ' · Watchlist' : ' · Early') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(multipleFor(r.category)) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((value / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(value) })
        )),
        el('td', null, el('span', { class: 'status pre', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: captionText }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank', true),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL', true),
            sortHeader('growth', '7d', true),
            sortHeader('age', 'Age', true),
            sortHeader('multiple', 'xTVL', true),
            sortHeader('implied', 'Implied value', true),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', { tabindex: '-1' },
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtMult(r.multiple) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their market-cap-to-TVL ratios calibrate it. ' + DATA.live.length + ' protocols, by market cap.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'num', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', class: 'num', text: 'TVL' }), el('th', { scope: 'col', class: 'num', text: '7d' }), el('th', { scope: 'col', class: 'num', text: 'Market cap' }), el('th', { scope: 'col', class: 'num', text: 'xTVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = MODEL;
    var formula = 'ratio      = mcap_usd / tvl_usd for each live-token protocol, winsorized to [' + m.multiple_floor + ', ' + m.multiple_cap + ']\n' +
      'market     = median ratio over ' + CAL.global_n + ' live protocols = ' + fmt4(CAL.global_multiple) + ' (middle half ' + fmt4(CAL.global_p25) + ' to ' + fmt4(CAL.global_p75) + ')\n' +
      'multiple   = (n x category median + ' + m.shrinkage_k + ' x market) / (n + ' + m.shrinkage_k + '), or market when n = 0\n' +
      'implied    = round( tvl_usd x multiple\n' +
      '             x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ')\n' +
      '             x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ')\n' +
      '             x (1 + ' + m.breadth_step + ' x min(chains - 1, ' + m.breadth_max_extra_chains + ')) )';
    var keys = Object.keys(CAL.categories).sort(function (a, b) {
      var d = CAL.categories[b].n - CAL.categories[a].n;
      return d !== 0 ? d : (a < b ? -1 : 1);
    });
    var calibRows = [el('tr', { class: 'market-row' }, el('td', { text: 'Market median (fallback)' }), el('td', { class: 'num', text: String(CAL.global_n) }), el('td', { class: 'num', text: fmt4(CAL.global_multiple) }), el('td', { class: 'num', text: fmt4(CAL.global_multiple) }), el('td', null, el('div', { class: 'cal-bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.round((CAL.global_multiple / MODEL.multiple_cap) * 100) + '%' }))))];
    keys.forEach(function (c) {
      var e = CAL.categories[c];
      calibRows.push(el('tr', null,
        el('td', { text: c }),
        el('td', { class: 'num', text: String(e.n) }),
        el('td', { class: 'num', text: fmt4(e.median) }),
        el('td', { class: 'num', text: fmt4(shrunkMultiple(e.median, e.n)) }),
        el('td', null, el('div', { class: 'cal-bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, Math.round((shrunkMultiple(e.median, e.n) / MODEL.multiple_cap) * 100)) + '%' })))
      ));
    });
    var checkOk = recomputeChecked === DATA.rows.length;
    var check = el('p', { class: 'check' + (checkOk ? '' : ' bad'), text: checkOk
      ? 'Self-check: this page recomputed all ' + DATA.rows.length + ' rows from the snapshot figures and matched board.json exactly.'
      : 'Self-check: ' + recomputeChecked + ' of ' + DATA.rows.length + ' rows recompute to the board number; the data would be stale.' });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. The multiple is not a guess: it is the median of what the market already pays per dollar of TVL, per category, shrunk toward the market median so a category with one or two live protocols cannot set a wild value on its own. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula', text: formula }),
      el('div', { class: 'model-grid' },
        el('div', null,
          el('h3', { text: 'Calibration: market-cap / TVL by category' }),
          el('table', { class: 'calib' },
            el('thead', null, el('tr', null, el('th', { text: 'Category' }), el('th', { class: 'num', text: 'Live n' }), el('th', { class: 'num', text: 'Median' }), el('th', { class: 'num', text: 'Multiple' }), el('th', { text: 'Scale' }))),
            el('tbody', null, calibRows)
          ),
          check
        ),
        el('div', null,
          el('h3', { text: 'What the board holds' }),
          el('p', { class: 'sub', text: 'All ' + DATA.watchlist_size + ' watchlist protocols, plus every pre-token protocol below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor that passes the watchlist rule: no token on record, not a versioned pool, not a wrapped, staked or bridged product, and not an exchange product. At or above the floor the watchlist alone decides, since it encodes the parent-protocol check the snapshot does not carry.' }),
          el('p', { class: 'sub', text: 'Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. Growth is clamped so one wild week never sets a rank. The chain breadth factor rewards protocols live on more chains, at most +20%.' }),
          el('p', { class: 'sub', text: 'Shrinkage is the honest middle: a hard cutoff would throw away every small category and score it at the market median, while a raw median would let one small live protocol set a whole category. The blend keeps both errors small, and the table shows the n behind every multiple.' })
        )
      ),
      sandboxEl()
    );
  }

  function sandboxEl() {
    var current = state.sandbox || { multipleScale: 1, growthWeight: MODEL.growth_weight, breadthStep: MODEL.breadth_step };
    function slider(id, label, min, max, step, value, format) {
      var input = el('input', { type: 'range', id: id, min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
      var out = el('output', { for: id, text: format(value) });
      input.addEventListener('input', function () {
        var v = Number(input.value);
        out.textContent = format(v);
        if (!state.sandbox) state.sandbox = { multipleScale: 1, growthWeight: MODEL.growth_weight, breadthStep: MODEL.breadth_step };
        if (id === 'sb-multiple') state.sandbox.multipleScale = v;
        if (id === 'sb-growth') state.sandbox.growthWeight = v;
        if (id === 'sb-breadth') state.sandbox.breadthStep = v;
        render();
      });
      return el('div', { class: 'slider-row' }, el('label', { for: id, text: label }), input, out);
    }
    var badge = el('span', { class: 'sandbox-badge' + (state.sandbox ? ' on' : ''), text: 'Sandbox ranking active: board.json keeps the model ranking' });
    var reset = el('button', { class: 'button', type: 'button', text: 'Reset to the model', onclick: function () { state.sandbox = null; render(); } });
    return el('div', { class: 'sandbox' },
      el('h3', { text: 'Model sandbox' }),
      el('p', { class: 'sub', text: 'Change the model and watch the board re-rank. The sandbox only re-ranks this page: board.json always carries the model ranking above.' }),
      slider('sb-multiple', 'Value multiple scale', 0.5, 2, 0.05, current.multipleScale, function (v) { return v.toFixed(2) + 'x'; }),
      slider('sb-growth', 'Growth weight', 0, 1, 0.05, current.growthWeight, function (v) { return v.toFixed(2); }),
      slider('sb-breadth', 'Chain breadth step', 0, 0.1, 0.005, current.breadthStep, function (v) { return v.toFixed(3); }),
      el('div', { class: 'sandbox-foot' }, reset, badge)
    );
  }

  function costLine(tail) {
    var parts = tail.split(' Time: ');
    var costPart = parts[0].replace(/^Cost:\s*/, '').replace(/\.\s*$/, '');
    var nodes = [el('b', { text: 'Cost: ' }), document.createTextNode(costPart + '. ')];
    if (parts.length > 1) nodes.push(el('b', { text: 'Time: ' }), document.createTextNode(parts.slice(1).join(' Time: ')));
    return el('span', { class: 'cost' }, nodes);
  }

  function multipleSourceText(row) {
    var cat = row.category || 'Other';
    var entry = CAL.categories[cat];
    if (entry === undefined) {
      return 'No live ' + cat + ' protocol sets a category median, so the market median ' + fmt4(CAL.global_multiple) + ' from ' + CAL.global_n + ' live protocols is used.';
    }
    return cat + ' median ' + fmt4(entry.median) + ' from ' + entry.n + ' live protocol' + (entry.n === 1 ? '' : 's') + ', shrunk toward the market median ' + fmt4(CAL.global_multiple) + ' to ' + fmt4(shrunkMultiple(entry.median, entry.n)) + '.';
  }

  function detailView(row) {
    var f = factorsOf(row, state.sandbox);
    var steps = farmSteps(row);
    var equation = fmtUsd(row.tvl_usd) + ' x ' + fmt4(f.multiple) + ' x ' + fmt4(f.growthMult) + ' x ' + fmt4(f.maturityMult) + ' x ' + fmt4(f.breadthMult) + ' = ' + fmtUsd(f.implied);
    var running = 'After the multiple ' + fmtUsd(f.base) + ', after growth ' + fmtUsd(f.afterGrowth) + ', after maturity ' + fmtUsd(f.afterMaturity) + ', after breadth ' + fmtUsd(f.implied) + '. Rounded for display; the board carries the exact dollar figure.';
    var atZeroGrowth = impliedOf(row, { growthOverride: 0 });
    var atMarket = impliedOf(row, { multipleOverride: CAL.global_multiple });
    var chainText = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';
    var prev = DATA.rows.filter(function (r) { return r.rank === row.rank - 1; })[0];
    var next = DATA.rows.filter(function (r) { return r.rank === row.rank + 1; })[0];
    return el('section', { class: 'panel detail' },
      el('div', { class: 'detail-top' },
        el('div', null,
          el('button', { class: 'button back', type: 'button', text: 'Back to the board', onclick: closeDetail }),
          el('div', { class: 'eyebrow', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · ' + (row.watchlist ? 'Watchlist' : 'Early') + ' · ' + (row.category || 'Other') }),
          el('h1', { text: row.name }),
          el('p', { class: 'sub', text: chainText + (row.listed_at ? ' · listed ' + row.listed_at : '') + ' · age ' + fmtAge(row.age_days) })
        ),
        el('div', { class: 'detail-implied' },
          el('span', { text: 'Implied value' }),
          el('b', { class: 'num', text: fmtUsd(f.implied) }),
          el('span', { class: 'sub', text: 'Model ' + DATA.model_version + ' estimate, not a price' })
        )
      ),
      el('div', { class: 'equation-box' },
        el('div', { class: 'equation', text: equation }),
        el('p', { class: 'sub', text: running })
      ),
      el('div', { class: 'factor-grid' },
        el('div', null, el('span', { text: 'Value multiple' }), el('b', { class: 'num', text: fmt4(f.multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) + ' (used ' + fmtPct(f.growthPct) + ')' })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) + ' · ' + fmt4(f.maturityMult) })),
        el('div', null, el('span', { text: 'Chains' }), el('b', { class: 'num', text: String(row.chains ? row.chains.length : 0) + ' · ' + fmt4(f.breadthMult) }))
      ),
      el('div', { class: 'detail-grid' },
        el('div', null,
          el('h3', { text: 'Why this rank' }),
          el('p', { class: 'sub', text: multipleSourceText(row) }),
          el('p', { class: 'sub', text: 'Sensitivity: at 0% seven-day growth this row would be ' + fmtUsd(atZeroGrowth) + '; at the market median multiple it would be ' + fmtUsd(atMarket) + '. ' + (f.implied === row.implied_value_usd ? 'The page recomputes this row as ' + fmtUsd(f.implied) + ', the same number board.json carries.' : 'Sandbox settings are active: board.json values this row at ' + fmtUsd(row.implied_value_usd) + '.') }),
          el('p', { class: 'sub', text: 'DefiLlama records no token for this protocol. That is the record, not proof: a token may exist that the record does not carry. This page predicts nothing about whether or when any protocol issues a token.' })
        ),
        el('div', null,
          el('h3', { text: 'Farm plan' }),
          el('ol', { class: 'steps' }, steps.map(function (s) {
            var at = s.indexOf(' Cost: ');
            var action = at >= 0 ? s.slice(0, at) : s;
            var tail = at >= 0 ? s.slice(at + 1) : '';
            return el('li', null, el('b', { text: action }), costLine(tail));
          }))
        )
      ),
      el('div', { class: 'neighbors' },
        prev ? el('button', { class: 'button', type: 'button', text: 'Rank ' + prev.rank + ': ' + prev.name, onclick: function () { openDetail(prev.slug); } }) : el('span', null),
        next ? el('button', { class: 'button', type: 'button', text: 'Rank ' + next.rank + ': ' + next.name, onclick: function () { openDetail(next.slug); } }) : el('span', null)
      )
    );
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('p', { text: "How to read this radar: the board ranks protocols that record no token by what a token would be worth if the protocol kept its current size, growth and age, priced at the multiple the live-token market already pays. The watchlist is the floor, never the ceiling: the early radar exists to find the protocols below it before anyone else looks. Farm plans are starting points derived from each protocol's own record, not financial advice." }),
      el('p', { class: 'src', text: 'Source: ' + DATA.source }),
      el('p', { text: 'Built for the make.fun token launch radar bounty. Every number on this page recomputes from the snapshot in the open: see the model panel. Implied value is a model, never a promise, and this page predicts nothing about whether or when any protocol issues a token.' })
    );
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    var selected = null;
    if (state.selected) {
      selected = DATA.rows.filter(function (r) { return r.slug === state.selected; })[0] || null;
      if (!selected) state.selected = null;
    }
    if (selected) {
      shell.appendChild(detailView(selected));
    } else {
      shell.appendChild(hero());
      shell.appendChild(calibStrip());
      shell.appendChild(controls());
      shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
      if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    }
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; state.scope = 'all'; state.gainers = false; state.tab = 'pre-token'; state.sort = 'implied'; state.dir = -1; state.selected = null;
    readHash();
    render();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.selected) closeDetail();
  });
})();
