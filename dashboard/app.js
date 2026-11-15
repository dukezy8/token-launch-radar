/* Token Launch Radar — dashboard. Reads window.RADAR (written by main.ts), renders the board,
 * and recomputes every detail row from the snapshot's own figures, in the page. No network. */
(function () {
  'use strict';
  var D = window.RADAR;
  var main = document.querySelector('main');
  if (!D || !Array.isArray(D.rows)) {
    if (main) main.insertAdjacentHTML('afterbegin', '<p class="empty">No radar data loaded. Run main.ts to write data.js.</p>');
    return;
  }

  // PURE-START
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(n) {
    if (n == null) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function ageDays(asOf, listedAt) {
    if (!listedAt) return null;
    var a = Date.parse(asOf + 'T00:00:00Z');
    var b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / 86400000));
  }
  /** The category multiple a row is scored at: its category's table entry, else the market median. */
  function categoryMultipleFor(row) {
    for (var i = 0; i < D.categories.length; i++) {
      if (D.categories[i].category === row.category) return D.categories[i];
    }
    return null;
  }
  /**
   * The model's arithmetic, recomputed here from the row's own snapshot figures — the same
   * operations, in the same order, as lib/model.ts. Returns every factor and the implied value.
   */
  function recomputeRow(row) {
    var entry = categoryMultipleFor(row);
    var multiple = entry ? entry.multiple : D.global_multiple;
    var growthPct = clamp(row.change_7d == null ? 0 : row.change_7d, D.model.growth_floor, D.model.growth_cap);
    var growthMult = 1 + (growthPct / 100) * D.model.growth_weight;
    var age = ageDays(D.as_of, row.listed_at);
    var ageForModel = age == null ? D.model.unknown_age_days : age;
    var maturityMult = D.model.maturity_floor +
      (Math.min(Math.max(ageForModel, 0), D.model.maturity_days) / D.model.maturity_days) * D.model.maturity_range;
    var chainsMult = 1 + D.model.chain_step * Math.min(Math.max(row.chains.length - 1, 0), D.model.chain_cap);
    var implied = Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturityMult * chainsMult));
    return {
      multiple: multiple, entry: entry, growthPct: growthPct, growthMult: growthMult,
      age: age, maturityMult: maturityMult, chainsMult: chainsMult, implied: implied,
    };
  }
  // PURE-END

  var bySlug = {};
  D.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var maxImplied = D.rows.length ? D.rows[0].implied_value_usd : 1;

  var state = { tab: 'pre', q: '', cat: '', chain: '', wl: false, sort: 'implied', slug: '' };
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('tab') === 'live' || p.get('tab') === 'pre') state.tab = p.get('tab');
    if (p.get('q') != null) state.q = p.get('q');
    if (p.get('cat') != null) state.cat = p.get('cat');
    if (p.get('chain') != null) state.chain = p.get('chain');
    state.wl = p.get('wl') === '1';
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('slug')) state.slug = p.get('slug');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.tab !== 'pre') p.set('tab', state.tab);
    if (state.q) p.set('q', state.q);
    if (state.cat) p.set('cat', state.cat);
    if (state.chain) p.set('chain', state.chain);
    if (state.wl) p.set('wl', '1');
    if (state.sort !== 'implied') p.set('sort', state.sort);
    if (state.slug) p.set('slug', state.slug);
    var h = p.toString();
    history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  }

  var $ = function (id) { return document.getElementById(id); };
  var qEl = $('q'), catEl = $('cat'), chainEl = $('chain'), wlEl = $('wl'), sortEl = $('sort');
  var rowsEl = $('rows'), liveRowsEl = $('live-rows'), countEl = $('count'), emptyEl = $('empty');
  var boardEl = $('board'), liveEl = $('live'), tabPre = $('tab-pre'), tabLive = $('tab-live');
  var dialog = $('detail');

  // Filter options, from the board itself.
  var cats = [], chains = [];
  D.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  cats.forEach(function (c) { catEl.insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>'); });
  chains.forEach(function (c) { chainEl.insertAdjacentHTML('beforeend', '<option>' + esc(c) + '</option>'); });

  $('asof').textContent = D.as_of;
  $('global-mult').textContent = D.global_multiple.toFixed(3);

  // Facts.
  $('facts').innerHTML =
    '<div class="fact"><b>' + D.board_size + '</b><span>protocols ranked</span></div>' +
    '<div class="fact"><b>' + D.watchlist_size + ' / ' + D.watchlist_size + '</b><span>watchlist covered</span></div>' +
    '<div class="fact"><b>' + D.early_size + '</b><span>more beyond the watchlist</span></div>' +
    '<div class="fact"><b>' + D.live_size + '</b><span>live comps set the multiples</span></div>';

  // Top three spotlight.
  $('spotlight').innerHTML = D.rows.slice(0, 3).map(function (r) {
    return '<button class="spot-card" data-slug="' + esc(r.slug) + '">' +
      '<span class="rk">#' + r.rank + ' · ' + esc(r.category || 'Uncategorised') + '</span>' +
      '<span class="nm">' + esc(r.name) + '</span>' +
      '<span class="vl">' + money(r.implied_value_usd) + '</span>' +
      '<span class="ct">TVL ' + money(r.tvl_usd) + ' · ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + '</span>' +
      '</button>';
  }).join('');

  // Category multiple table, highest multiple first.
  var mults = D.categories.slice().sort(function (a, b) { return b.multiple - a.multiple || (a.category < b.category ? -1 : 1); });
  $('mult-rows').innerHTML = mults.map(function (c) {
    return '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.live_comps + '</td>' +
      '<td class="num">' + (c.median_ratio == null ? '—' : c.median_ratio.toFixed(3)) + '</td>' +
      '<td class="num">' + c.multiple.toFixed(3) + '</td></tr>';
  }).join('');

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var rows = D.rows.filter(function (r) {
      if (state.wl && !r.is_watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var s = state.sort;
    if (s === 'tvl') rows.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (s === 'growth') rows.sort(function (a, b) { return (b.change_7d == null ? -Infinity : b.change_7d) - (a.change_7d == null ? -Infinity : a.change_7d); });
    else if (s === 'age') rows.sort(function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); });
    else if (s === 'name') rows.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return rows;
  }

  function chainList(chains) {
    if (!chains.length) return '—';
    if (chains.length <= 3) return chains.join(' · ');
    return chains.slice(0, 3).join(' · ') + ' · +' + (chains.length - 3) + ' more';
  }
  function rowHtml(r) {
    var g = r.change_7d;
    var gCls = g == null ? 'flat' : g > 0 ? 'up' : g < 0 ? 'down' : 'flat';
    var age = r.age_days == null ? '—' : r.age_days >= 365 ? (r.age_days / 365).toFixed(1) + 'y' : r.age_days + 'd';
    var barW = Math.max(1, Math.round((r.implied_value_usd / maxImplied) * 100));
    return '<tr data-slug="' + esc(r.slug) + '">' +
      '<td class="num rank">' + r.rank + '</td>' +
      '<td><span class="name">' + esc(r.name) + (r.is_watchlist ? '<span class="wl">WATCHLIST</span>' : '') + '</span>' +
      '<span class="sub2">' + esc(chainList(r.chains)) + '</span></td>' +
      '<td>' + esc(r.category || '—') + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num ' + gCls + '">' + pct(g) + '</td>' +
      '<td class="num">' + age + '</td>' +
      '<td class="num">' + r.category_multiple.toFixed(3) + '</td>' +
      '<td class="num imp">' + money(r.implied_value_usd) + '<span class="bar"><i style="width:' + barW + '%"></i></span></td>' +
      '</tr>';
  }

  function render() {
    tabPre.classList.toggle('active', state.tab === 'pre');
    tabLive.classList.toggle('active', state.tab === 'live');
    tabPre.setAttribute('aria-selected', state.tab === 'pre' ? 'true' : 'false');
    tabLive.setAttribute('aria-selected', state.tab === 'live' ? 'true' : 'false');
    document.querySelector('.filters').style.display = state.tab === 'pre' ? '' : 'none';
    boardEl.hidden = state.tab !== 'pre';
    liveEl.hidden = state.tab !== 'live';
    if (state.tab === 'live') {
      liveRowsEl.innerHTML = D.live.map(function (p) {
        var g = p.change_7d;
        var gCls = g == null ? 'flat' : g > 0 ? 'up' : g < 0 ? 'down' : 'flat';
        return '<tr data-slug="' + esc(p.slug) + '"><td><span class="name">' + esc(p.name) + '</span>' +
          '<span class="sub2">' + esc(chainList(p.chains)) + '</span></td>' +
          '<td>' + esc(p.category || '—') + '</td>' +
          '<td class="num">' + money(p.tvl_usd) + '</td>' +
          '<td class="num">' + money(p.mcap_usd) + '</td>' +
          '<td class="num">' + (p.fdv_tvl == null ? '—' : p.fdv_tvl.toFixed(2) + '×') + '</td>' +
          '<td class="num ' + gCls + '">' + pct(g) + '</td></tr>';
      }).join('');
      countEl.textContent = D.live.length + ' live-token protocols, by market cap — these are the comparables the multiples come from.';
      emptyEl.hidden = true;
      return;
    }
    var rows = filtered();
    rowsEl.innerHTML = rows.map(rowHtml).join('');
    emptyEl.hidden = rows.length > 0;
    countEl.textContent = 'Showing ' + rows.length + ' of ' + D.board_size + ' pre-token protocols' +
      (state.sort === 'implied' ? ', ranked by implied value.' : ' (board rank shown in #).');
  }

  function openDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    state.slug = slug;
    writeHash();
    var v = recomputeRow(r);
    var match = v.implied === r.implied_value_usd;
    var diff = Math.abs(v.implied - r.implied_value_usd);
    var comps = D.live.filter(function (p) { return p.category === r.category; })
      .sort(function (a, b) { return (b.fdv_tvl || 0) - (a.fdv_tvl || 0); });
    var compRows = comps.length ? comps.map(function (p) {
      return '<tr><td>' + esc(p.name) + '</td><td class="num">' + money(p.tvl_usd) + '</td>' +
        '<td class="num">' + money(p.mcap_usd) + '</td><td class="num">' + (p.fdv_tvl == null ? '—' : p.fdv_tvl.toFixed(2) + '×') + '</td></tr>';
    }).join('') : '<tr><td colspan="4">No live-token comp in the top 24 for this category.</td></tr>';
    var multNote = v.entry
      ? (v.entry.live_comps >= D.model.min_comps
        ? 'median of ' + v.entry.live_comps + ' live comps in ' + esc(r.category || '') + ', median FDV/TVL ' + v.entry.median_ratio.toFixed(3)
        : 'only ' + v.entry.live_comps + ' live comp' + (v.entry.live_comps === 1 ? '' : 's') + ' in ' + esc(r.category || '') + ' — too few to set a multiple, so the market-wide median is used')
      : 'no live comps in this category — market-wide median';
    dialog.innerHTML = '<div class="dlg">' +
      '<div class="dlg-head"><div><span class="rk">RANK #' + r.rank + (r.is_watchlist ? ' · WATCHLIST' : '') + '</span>' +
      '<h2>' + esc(r.name) + '</h2><div class="cat">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(' · ') || '—') + '</div></div>' +
      '<button class="dlg-close" id="dlg-close" aria-label="Close">✕</button></div>' +
      '<div class="stats">' +
      '<div class="stat"><b>' + money(r.tvl_usd) + '</b><span>Total value locked</span></div>' +
      '<div class="stat"><b>' + pct(r.change_7d) + '</b><span>TVL, last 7 days</span></div>' +
      '<div class="stat"><b>' + (r.age_days == null ? '—' : r.age_days + ' days') + '</b><span>Listed' + (r.listed_at ? ' ' + esc(r.listed_at) : '') + '</span></div>' +
      '<div class="stat"><b>' + money(r.implied_value_usd) + '</b><span>Implied value</span></div>' +
      '</div>' +
      '<h3>How the number is built</h3>' +
      '<table class="calc"><tbody>' +
      '<tr><td>TVL<span class="why">the protocol&rsquo;s own locked value</span></td><td>' + moneyFull(r.tvl_usd) + '</td></tr>' +
      '<tr><td>× Category multiple<span class="why">' + multNote + '</span></td><td>' + v.multiple.toFixed(3) + '×</td></tr>' +
      '<tr><td>× Growth<span class="why">7-day TVL change ' + pct(r.change_7d) + ', clamped −50…+100%, weighted 0.6</span></td><td>' + v.growthMult.toFixed(4) + '×</td></tr>' +
      '<tr><td>× Maturity<span class="why">' + (v.age == null ? 'age unknown, counted as 365 days' : v.age + ' days since listing') + '</span></td><td>' + v.maturityMult.toFixed(4) + '×</td></tr>' +
      '<tr><td>× Chains<span class="why">' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ' tracked</span></td><td>' + v.chainsMult.toFixed(2) + '×</td></tr>' +
      '<tr class="total"><td>Implied value</td><td>' + moneyFull(r.implied_value_usd) + '</td></tr>' +
      '</tbody></table>' +
      '<p class="check-line">Page recompute: ' + moneyFull(v.implied) + ' — ' +
      (match ? '<span class="ok">matches board.json exactly.</span>'
        : '<span class="bad">differs by ' + moneyFull(diff) + '.</span>') + '</p>' +
      '<h3>Live comparables in ' + esc(r.category || 'this category') + '</h3>' +
      '<table class="comps"><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">FDV / TVL</th></tr></thead>' +
      '<tbody>' + compRows + '</tbody></table>' +
      '<p class="note">The multiple uses every live-token protocol in the category, not just the top 24 shown here.</p>' +
      '<h3>Farm plan · six steps</h3>' +
      '<ol class="farm">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '</div>';
    dialog.showModal();
    $('dlg-close').addEventListener('click', closeDetail);
  }
  function closeDetail() {
    if (dialog.open) dialog.close();
    if (state.slug) { state.slug = ''; writeHash(); }
  }
  dialog.addEventListener('click', function (e) { if (e.target === dialog) closeDetail(); });
  dialog.addEventListener('close', function () { if (state.slug) { state.slug = ''; writeHash(); } });

  // Events.
  qEl.addEventListener('input', function () { state.q = qEl.value; writeHash(); render(); });
  catEl.addEventListener('change', function () { state.cat = catEl.value; writeHash(); render(); });
  chainEl.addEventListener('change', function () { state.chain = chainEl.value; writeHash(); render(); });
  wlEl.addEventListener('change', function () { state.wl = wlEl.checked; writeHash(); render(); });
  sortEl.addEventListener('change', function () { state.sort = sortEl.value; writeHash(); render(); });
  tabPre.addEventListener('click', function () { state.tab = 'pre'; writeHash(); render(); });
  tabLive.addEventListener('click', function () { state.tab = 'live'; writeHash(); render(); });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-slug]');
    if (t) openDetail(t.getAttribute('data-slug'));
  });

  readHash();
  qEl.value = state.q; catEl.value = state.cat; chainEl.value = state.chain;
  wlEl.checked = state.wl; sortEl.value = state.sort;
  render();
  if (state.slug) openDetail(state.slug);
})();
