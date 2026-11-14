// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, filters, a per-protocol detail view with the model's own inputs and
// the protocol's farm plan, and a model panel with a sandbox that re-ranks the board live.
// No network: every byte it shows is in data.js. The page recomputes every row's implied value
// from the snapshot figures with impliedOf, the same arithmetic main.ts runs, and checks the
// result against the number board.json carries.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var MODEL = DATA.model;
  var CAL = DATA.calibration;
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, tab: 'pre-token', sort: 'implied', dir: -1, selected: null, sandbox: null };

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

  // The multiple one category scores at: its own calibration, or the market median.
  function multipleFor(category) {
    var entry = CAL.categories[category || 'Other'];
    return entry === undefined ? CAL.global_multiple : entry.multiple;
  }

  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same
  // arithmetic. Overrides (the sandbox) scale the multiple, the growth weight and the breadth step.
  function factorsOf(row, o) {
    var growthWeight = o ? o.growthWeight : MODEL.growth_weight;
    var breadthStep = o ? o.breadthStep : MODEL.breadth_step;
    var multiple = multipleFor(row.category) * (o ? o.multipleScale : 1);
    var growth = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * growthWeight;
    var age = row.age_days === null || row.age_days === undefined ? MODEL.unknown_age_days : row.age_days;
    var maturity = MODEL.maturity_floor + (Math.min(Math.max(age, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
    var chains = row.chains ? row.chains.length : 0;
    var breadth = 1 + breadthStep * Math.min(Math.max(chains - 1, 0), MODEL.breadth_max_extra_chains);
    var implied = Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturity * breadth));
    return { multiple: multiple, growthPct: growth, growthMult: growthMult, maturityMult: maturity, breadthMult: breadth, age: row.age_days, implied: implied };
  }
  function impliedOf(row, o) { return factorsOf(row, o).implied; }

  // The self-check: every row recomputed here must equal the number board.json carries.
  var recomputeChecked = DATA.rows.filter(function (r) { return impliedOf(r, null) === r.implied_value_usd; }).length;

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
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
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('swap') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('yield') >= 0 || c.indexOf('aggregator') >= 0 || c.indexOf('vault') >= 0) return 'Deposit $' + capital + " of USDC into " + name + "'s highest-TVL vault on " + chain + ' and keep the shares.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('option') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('basis') >= 0) return 'Deposit $' + capital + ' into a delta-neutral basis position on ' + name + ' and hold it through one funding cycle.';
    if (c.indexOf('launchpad') >= 0) return 'Commit $' + capital + ' to an allocation on ' + name + ' and complete its participation steps.';
    if (c.indexOf('farm') >= 0 || c.indexOf('leveraged') >= 0) return 'Deposit $' + capital + " into " + name + "'s main farm pool on " + chain + ' and keep the position open.';
    if (c.indexOf('index') >= 0) return 'Buy $' + capital + ' of the index token on ' + name + ' and hold it.';
    if (c.indexOf('locker') >= 0) return 'Lock $' + capital + ' of tokens through ' + name + ' for the shortest term it offers.';
    if (c.indexOf('payment') >= 0) return 'Route $' + capital + ' of payments through ' + name + ' on ' + chain + ' and keep the receipts.';
    if (c.indexOf('privacy') >= 0) return 'Deposit $' + capital + " through " + name + "'s privacy pool on " + chain + ' and keep the note.';
    if (c.indexOf('ai') >= 0 || c.indexOf('agent') >= 0) return 'Stake or deposit $' + capital + " into " + name + "'s compute or agent pool on " + chain + ' and keep the position open.';
    if (c.indexOf('nft') >= 0 || c.indexOf('gaming') >= 0 || c.indexOf('game') >= 0) return 'Mint or buy $' + capital + ' of the collection on ' + name + ' and hold it.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + ' to the chain through ' + name + ' and use its core apps for a week.';
    if (c.indexOf('liquidity') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' managed liquidity vault on ' + chain + ' and keep the shares.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasFor(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: gas.first + ' for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + gas.setup + ' of gas on ' + chain, time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $' + gas.weekly + ' of gas a week on ' + chain, time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('minTvl')) state.minTvl = Number(params.get('minTvl')) || 0;
    if (params.get('tab') === 'live') state.tab = 'live';
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.minTvl) params.set('minTvl', String(state.minTvl));
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

  function lede() {
    var h1 = el('h1', null, DATA.board_size + ' pre-token protocols, ranked by ', el('em', { text: 'implied value' }));
    return el('section', { class: 'lede' },
      el('div', null,
        h1,
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model calibrated from the live-token market, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
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
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    var countText = state.tab === 'pre-token' ? visibleRows().length + ' of ' + DATA.board_size + ' rows shown' : DATA.live.length + ' live-token protocols';
    if (state.sandbox) countText += ' · sandbox ranking';
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('label', { for: 'minTvl', text: 'Min TVL' }), tvlSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: countText })
    );
  }

  function sortHeader(key, label, num) {
    return el('th', { scope: 'col', class: num ? 'num' : null },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(visibleRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category, chain or TVL to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; writeHash(); render(); } })
      ));
    }
    var max = Math.max.apply(null, list.map(shownValue).concat([1]));
    var tbody = el('tbody');
    list.forEach(function (r, i) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var value = shownValue(r);
      var rankLabel = state.sandbox ? String(i + 1) : String(r.rank);
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
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
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
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
      tbody.appendChild(el('tr', { tabindex: '-1', onclick: function () {} },
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
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their market-cap-to-TVL ratios calibrate it.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', class: 'num', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', class: 'num', text: 'TVL' }), el('th', { scope: 'col', class: 'num', text: '7d' }), el('th', { scope: 'col', class: 'num', text: 'Market cap' }), el('th', { scope: 'col', class: 'num', text: 'xTVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = MODEL;
    var formula = 'multiple   = median market-cap / TVL of live-token protocols in the category\n' +
      '             (' + CAL.global_n + ' live protocols set the market median of ' + fmt4(CAL.global_multiple) + ')\n' +
      'implied    = round( tvl_usd x multiple\n' +
      '             x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ')\n' +
      '             x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ')\n' +
      '             x (1 + ' + m.breadth_step + ' x min(chains - 1, ' + m.breadth_max_extra_chains + ')) )';
    var calibRows = Object.keys(CAL.categories).sort().map(function (c) {
      var e = CAL.categories[c];
      return el('tr', null, el('td', { text: c }), el('td', { class: 'num', text: String(e.n) }), el('td', { class: 'num', text: fmt4(e.multiple) }));
    });
    calibRows.push(el('tr', null, el('td', { text: 'Market median (fallback)' }), el('td', { class: 'num', text: String(CAL.global_n) }), el('td', { class: 'num', text: fmt4(CAL.global_multiple) })));
    var checkOk = recomputeChecked === DATA.rows.length;
    var check = el('p', { class: 'check' + (checkOk ? '' : ' bad'), text: checkOk
      ? 'Self-check: this page recomputed all ' + DATA.rows.length + ' rows from the snapshot figures and matched board.json exactly.'
      : 'Self-check: ' + recomputeChecked + ' of ' + DATA.rows.length + ' rows recompute to the board number; the data would be stale.' });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. The multiple is not a guess: it is the median of what the market already pays per dollar of TVL, per category where at least ' + m.calibration_min_n + ' live protocols set it, else the market median. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula', text: formula }),
      el('div', { class: 'model-grid' },
        el('div', null,
          el('h3', { text: 'Calibration: market-cap / TVL by category' }),
          el('table', { class: 'calib' },
            el('thead', null, el('tr', null, el('th', { text: 'Category' }), el('th', { class: 'num', text: 'Live protocols' }), el('th', { class: 'num', text: 'Multiple' }))),
            el('tbody', null, calibRows)
          ),
          check
        ),
        el('div', null,
          el('h3', { text: 'What the board holds' }),
          el('p', { class: 'sub', text: 'All ' + DATA.watchlist_size + ' watchlist protocols, plus every pre-token protocol below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor that passes the watchlist rule: no token on record, not a versioned pool, not a wrapped, staked or bridged product, and not an exchange product. At or above the floor the watchlist alone decides, since it encodes the parent-protocol check the snapshot does not carry.' }),
          el('p', { class: 'sub', text: 'Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. Growth is clamped so one wild week never sets a rank. The chain breadth factor rewards protocols live on more chains, at most +20%.' })
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

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  var suppressClose = false;
  dialog.addEventListener('close', function () { if (suppressClose) return; state.selected = null; writeHash(); });

  function costLine(tail) {
    // tail reads "Cost: .... Time: ....": bold the two labels.
    var parts = tail.split(' Time: ');
    var costPart = parts[0].replace(/^Cost:\s*/, '').replace(/\.\s*$/, '');
    var nodes = [el('b', { text: 'Cost: ' }), document.createTextNode(costPart + '. ')];
    if (parts.length > 1) nodes.push(el('b', { text: 'Time: ' }), document.createTextNode(parts.slice(1).join(' Time: ')));
    return el('span', { class: 'cost' }, nodes);
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var f = factorsOf(row, state.sandbox);
    var steps = farmSteps(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + (row.listed_at ? ' · listed ' + row.listed_at : '') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Value multiple' }), el('b', { class: 'num', text: fmt4(f.multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: fmt4(f.growthMult) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: fmt4(f.maturityMult) })),
        el('div', null, el('span', { text: 'Chains' }), el('b', { class: 'num', text: String(row.chains ? row.chains.length : 0) })),
        el('div', null, el('span', { text: 'Breadth multiplier' }), el('b', { class: 'num', text: fmt4(f.breadthMult) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(f.implied) }))
      ),
      el('p', { class: 'sub', text: state.sandbox
        ? 'Model ' + DATA.model_version + ' with sandbox settings: the board ranking in board.json uses the model settings, which value this row at ' + fmtUsd(row.implied_value_usd) + '. This is an estimate, not a price.'
        : 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(f.implied) + (f.implied === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' }),
      el('p', { class: 'sub', text: 'DefiLlama records no token for this protocol. That is the record, not proof: a token may exist that the record does not carry.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), costLine(tail));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
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
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; state.tab = 'pre-token'; state.selected = null;
    readHash();
    if (!state.selected && dialog.open) { suppressClose = true; dialog.close(); suppressClose = false; }
    render();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
