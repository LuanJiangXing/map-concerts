/* app.js —— 数据加载、城市聚合、标签筛选、事件接线
 *
 * 数据来源:GET /api/performances(Worker 读取 D1)+ GET /api/tags(标签目录),异步加载。
 * 歌手页:标签计数调 GET /api/tags?singer={id}(仅该歌手);未知歌手 → 友好空态,不渲染地图。
 * 筛选语义:同类别 OR、跨类别 AND(参照 geoguide),在客户端进行。
 */

(function () {
  'use strict';

  // 本页有 reveal 主脚本:门控归这里管,由 /js/boot.js 读取(见该文件注释)
  window.__appBooted = true;

  var all = [];
  var tagCatalog = { categories: [] };
  var selectedTagsByCategory = {}; // { categoryId: Set<tagId> }
  var searchQ = ''; // 歌手页搜索词(已 lower):标题/城市 子串,与标签筛选 AND(2026-09-09)
  var FILTER_SEARCH_THRESHOLD = 25; // 类别标签 ≥25 → 面板列内给快速过滤框(歌曲等大目录);年份等短列不出现
  var megaRoot = null, megaPanel = null; // 单一大下拉(见 buildFilters)
  var yearBar = null; // 年份跨度条实例(/js/yearbar.js;渲染与筛选状态贯通,见 mountYearBar)
  // 筛选按钮图标:三条横线 + 把手(geoguessr preferences 同款,内联以免外链/新请求)
  var ICON_PREFS =
    '<path d="M23,3H12v2h11c.552,0,1-.448,1-1s-.448-1-1-1Z"/>' +
    '<path d="M1,5H6v2c0,.552,.448,1,1,1h2c.552,0,1-.448,1-1V1c0-.552-.448-1-1-1h-2c-.552,0-1,.448-1,1V3H1c-.552,0-1,.448-1,1s.448,1,1,1Z"/>' +
    '<path d="M23,19H12v2h11c.552,0,1-.448,1-1s-.448-1-1-1Z"/>' +
    '<path d="M1,21H6v2c0,.552,.448,1,1,1h2c.552,0,1-.448,1-1v-6c0-.552-.448-1-1-1h-2c-.552,0-1,.448-1,1v2H1c-.552,0-1,.448-1,1s.448,1,1,1Z"/>' +
    '<path d="M23,11h-3v2h3c.552,0,1-.448,1-1s-.448-1-1-1Z"/>' +
    '<path d="M1,13H14v2c0,.552,.448,1,1,1h2c.552,0,1-.448,1-1v-6c0-.552-.448-1-1-1h-2c-.552,0-1,.448-1,1v2H1c-.552,0-1,.448-1,1s.448,1,1,1Z"/>';
  function closeMega() {
    if (megaPanel && !megaPanel.hidden) {
      megaPanel.hidden = true;
      var b = document.getElementById('filter-toggle');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
  }
  var singerMatch = location.pathname.match(/^\/singer\/([A-Za-z0-9_-]+)/);
  var singer = singerMatch ? decodeURIComponent(singerMatch[1]) : null;

  /** 按城市聚合演出(取该城市第一条的坐标) */
  function groupByCity(list) {
    var m = {};
    list.forEach(function (p) {
      var key = p.city || '未知';
      if (!m[key]) {
        m[key] = { city: key, lat: p.lat, lng: p.lng, count: 0, items: [] };
      }
      m[key].count += 1;
      m[key].items.push(p);
    });
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  /** 搜索词命中:标题或城市名含 searchQ(小写子串);空词恒真(与标签筛选 AND,见 matches) */
  function hitSearch(p) {
    if (!searchQ) return true;
    return (p.title || '').toLowerCase().indexOf(searchQ) !== -1 ||
           (p.city || '').toLowerCase().indexOf(searchQ) !== -1;
  }

  /** 客户端筛选:搜索词先决(标题/城市命中,AND)+ 每个有选的类别须命中(AND);类别内任一选中标签命中即算(OR) */
  function matches(p) {
    if (!hitSearch(p)) return false;
    var catIds = Object.keys(selectedTagsByCategory).filter(function (c) { return selectedTagsByCategory[c].size > 0; });
    if (!catIds.length) return true;
    var tags = p.tags || [];
    for (var i = 0; i < catIds.length; i++) {
      var catId = catIds[i];
      var selected = selectedTagsByCategory[catId];
      var hit = false;
      for (var j = 0; j < tags.length; j++) {
        if (tags[j].category_id === catId && selected.has(tags[j].id)) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }

  /** 同 matches 但跳过 catId 类别(「某列候选」= 排除本列自身后其余列条件的匹配集,类内 OR 不自我约束)。
   *  搜索词同 matches 一并生效:搜索活跃时各列实时计数=其余列条件+搜索命中下的携带数 */
  function matchesIgnoring(p, catId) {
    if (!hitSearch(p)) return false;
    var catIds = Object.keys(selectedTagsByCategory).filter(function (c) {
      return c !== catId && selectedTagsByCategory[c].size > 0;
    });
    if (!catIds.length) return true;
    var tags = p.tags || [];
    for (var i = 0; i < catIds.length; i++) {
      var c = catIds[i];
      var selected = selectedTagsByCategory[c];
      var hit = false;
      for (var j = 0; j < tags.length; j++) {
        if (tags[j].category_id === c && selected.has(tags[j].id)) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }

  /* ---- 筛选动态可用性(2026-09-08,facet):勾选某条件后,其它列只留
   * 「其余列条件下命中数 >0」的标签;可见标签计数实时 = 当前条件下该标签命中场次数。
   * 数据源 = 前端全量 all(每场内联 p.tags)+ selectedTagsByCategory,无新接口。 ---- */
  var filterItems = []; // { catId, tagId, tag, label, cb, colEl, countText } 注册表(buildFilters 重建时清空)

  /** 某列 C 各标签实时命中数 = 排除 C 自身已选后,其余列条件下携带该标签的演出数 */
  function liveCountsFor(catId) {
    var cand = all.filter(function (p) { return matchesIgnoring(p, catId); });
    var out = {};
    cand.forEach(function (p) {
      var tags = p.tags || [];
      for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        if (t.category_id === catId) out[t.id] = (out[t.id] || 0) + 1;
      }
    });
    return out;
  }

  /** 单项可见 = 可用(计数>0 或已勾选恒可见)∧ 列内快速过滤 q 命中 */
  function applyVisibility(item) {
    var search = item.colEl.querySelector('.filter-mega__search');
    var q = search ? (search.value || '').trim() : '';
    var keyq = q ? (window.TagText ? TagText.key(q) : q.toLowerCase().replace(/\s+/g, '')) : '';
    item.label.hidden = (item.label.dataset.avail !== '1') ||
      (keyq !== '' && (item.label.dataset.search || '').indexOf(keyq) === -1);
  }

  /** 勾选/清除/基线重算入口:每列候选算一次,改写计数文本 + dataset.avail + 可见性 */
  function recomputeAvailability() {
    var liveByCat = {};
    for (var i = 0; i < filterItems.length; i++) {
      var catId = filterItems[i].catId;
      if (!liveByCat[catId]) liveByCat[catId] = liveCountsFor(catId);
    }
    for (var j = 0; j < filterItems.length; j++) {
      var item = filterItems[j];
      var counts = liveByCat[item.catId];
      var live = (counts && counts[item.tagId]) || 0;
      var avail = live > 0 || item.cb.checked;
      item.label.dataset.avail = avail ? '1' : '0';
      item.countText.nodeValue = ' (' + live + ')';
    }
    for (var k = 0; k < filterItems.length; k++) applyVisibility(filterItems[k]);
  }

  function filtered() {
    return all.filter(matches);
  }

  /* ---- 年份跨度条(S4b)--------------------------------------------------
   * 与筛选状态贯通:年份标签本就在 selectedTagsByCategory(「年份」类别,类内多选 OR,
   * 见 matches),年份条读写同一 Set<tagId>,不另立状态。点条 = 勾面板;勾面板 = 条同步。
   * 计数走 liveCountsFor(年份类别)—— 排除年份自身已选,故选中某年后其余年份仍见场次,
   * 与筛选面板的动态计数(facet)语义完全一致。 */
  function getYearCategory() {
    var cats = (tagCatalog && tagCatalog.categories) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].name === '年份') return cats[i];
    return null;
  }
  /** 当前条件下各年份场次:有年份类别 → facet 动态计数(标签 id 映射回年份);否则按 p.year 聚合 */
  function collectYearCounts() {
    var yc = getYearCategory();
    if (yc) {
      var raw = liveCountsFor(yc.id);
      var byYear = {};
      yc.tags.forEach(function (t) { var y = Number(t.name); if (y) byYear[y] = raw[t.id] || 0; });
      return { cat: yc, counts: byYear };
    }
    var counts = {};
    all.forEach(function (p) { if (p.year != null && p.year !== '') counts[p.year] = (counts[p.year] || 0) + 1; });
    return { cat: null, counts: counts };
  }
  /** 刻度范围 = min..max,并纳入类别里存在的年份标签(2026 等 0 场但有标签的年份也要在刻度上)
   *  —— 稀疏分布靠「有标签但 0 场 / 完全无标签」的淡刻度呈现,不许抹平。 */
  function yearSpan(counts, yc) {
    var ys = [];
    Object.keys(counts).forEach(function (k) { var n = Number(k); if (n) ys.push(n); });
    if (yc) yc.tags.forEach(function (t) { var n = Number(t.name); if (n) ys.push(n); });
    ys = ys.filter(function (n) { return n >= 1900 && n <= 2100; });
    if (!ys.length) return null;
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), out = [];
    for (var y = lo; y <= hi; y++) out.push(y);
    return out;
  }
  function yearSelectedSet(yc) {
    var out = new Set();
    if (yc && selectedTagsByCategory[yc.id]) {
      var sel = selectedTagsByCategory[yc.id];
      yc.tags.forEach(function (t) { if (sel.has(t.id)) out.add(Number(t.name)); });
    }
    return out;
  }
  /** 可点年份 = 该年标签存在且(当前场次 >0 或已被选中)——与面板「可用性」同一判据 */
  function yearActiveSet(yc, counts) {
    var out = new Set();
    if (!yc) return out;
    var sel = selectedTagsByCategory[yc.id];
    yc.tags.forEach(function (t) {
      var y = Number(t.name); if (!y) return;
      if ((counts[y] || 0) > 0 || (sel && sel.has(t.id))) out.add(y);
    });
    return out;
  }

  function afterFilterChange() {
    renderMap();
    refreshToggle();
    recomputeAvailability();
  }

  /** 点年份条:切换该年标签勾选,并同步筛选面板里同一个 checkbox */
  function toggleYear(y) {
    var yc = getYearCategory();
    if (!yc) return;
    var tag = null;
    yc.tags.forEach(function (t) { if (Number(t.name) === y) tag = t; });
    if (!tag) return;
    var set = selectedTagsByCategory[yc.id] || (selectedTagsByCategory[yc.id] = new Set());
    if (set.has(tag.id)) set.delete(tag.id); else set.add(tag.id);
    var on = set.has(tag.id);
    if (!set.size) delete selectedTagsByCategory[yc.id];
    for (var i = 0; i < filterItems.length; i++) {
      if (filterItems[i].catId === yc.id && filterItems[i].tagId === tag.id) filterItems[i].cb.checked = on;
    }
    afterFilterChange();
  }

  /** 「全部」:只清年份类别(其余筛选保留) */
  function clearYearFilter() {
    var yc = getYearCategory();
    if (!yc || !selectedTagsByCategory[yc.id] || !selectedTagsByCategory[yc.id].size) return;
    delete selectedTagsByCategory[yc.id];
    for (var i = 0; i < filterItems.length; i++) if (filterItems[i].catId === yc.id) filterItems[i].cb.checked = false;
    afterFilterChange();
  }

  /** 深链 ?year=YYYY(S4c:首页档案头版年份条 → /singer/{id}?year=YYYY)。
   *  数据就绪后读取一次,把对应「年份」标签预置进 selectedTagsByCategory
   *  —— 与筛选面板 / 年份条读写同一份状态,不引入第二份筛选真源。
   *  与 ?perf= 的差异(?perf= 会在命中后 replaceState 剥掉自己的参数以防刷新重弹;
   *  本条**全程不碰 history**,故刷新后年份筛选依然保持)。
   *  无年份类别 / 无该年标签 / 非法值(非四位、越界)→ 安全忽略,不报错、不留空态。
   *  另:该年必须**确有演出**才应用 —— 与歌手页年份条「0 场年份不可点」一致,
   *  避免 ?year=2026(有标签但 0 场)把页面推进 0 场空态。 */
  function applyYearDeepLink() {
    var raw = new URLSearchParams(location.search).get('year');
    if (!raw || !/^\d{4}$/.test(raw)) return;
    var y = Number(raw);
    if (y < 1900 || y > 2100) return;
    var yc = getYearCategory();
    if (!yc) return;
    var tag = null;
    yc.tags.forEach(function (t) { if (Number(t.name) === y) tag = t; });
    if (!tag) return;
    // 0 场年份:标签存在但该歌手该年无演出 → 忽略(与年份条 active 判据一致)
    var hasPerf = all.some(function (p) { return Number(p.year) === y; });
    if (!hasPerf) return;
    if (!selectedTagsByCategory[yc.id]) selectedTagsByCategory[yc.id] = new Set();
    selectedTagsByCategory[yc.id].add(tag.id);
  }

  function mountYearBar() {
    var host = document.getElementById('stats');
    if (!host || !window.YearBar) return;
    // 该歌手**总**演出为 0 → 不建年份条(否则会画出 27 根淡刻度、一根柱子都没有的柱状图)。
    // 判据用全量 all 而非筛选后的 list:手动筛到 0 条时年份条须保留,否则筛选器会自己消失、
    // 用户无法取消筛选。不建实例 → updateYearBar 走既有 !yearBar 回退,显示纯文本摘要。
    if (!all.length) return;
    var ctx = collectYearCounts();
    var years = yearSpan(ctx.counts, ctx.cat);
    if (!years) { host.textContent = ''; return; }
    yearBar = window.YearBar.create(host, {
      years: years,
      ariaLabel: '按年份筛选演出',
      onToggle: toggleYear,
      onClear: clearYearFilter
    });
  }

  function updateYearBar(list) {
    var summary = list.length + ' 场演出 · ' + groupByCity(list).length + ' 个城市';
    var el = document.getElementById('stats');
    if (!yearBar) { if (el) el.textContent = summary; return; }
    var ctx = collectYearCounts();
    yearBar.update({
      counts: ctx.counts,
      selected: yearSelectedSet(ctx.cat),
      activeYears: yearActiveSet(ctx.cat, ctx.counts),
      summary: summary
    });
  }

  function renderMap() {
    var list = filtered();
    updateYearBar(list);
    window.DTMap.render({
      container: 'map',
      cities: groupByCity(list),
      onCityClick: function (cityData) { window.Modal.open(cityData); },
      // 地图 SVG 渲染完成后再淡入:页面内容一起出现,不再"先出框架、地图慢一拍"
      onRendered: revealMap
    });
  }

  /** 已选标签总数(按钮摘要) */
  function countSelected() {
    var n = 0;
    Object.keys(selectedTagsByCategory).forEach(function (k) {
      var s = selectedTagsByCategory[k];
      if (s && s.size) n += s.size;
    });
    return n;
  }
  function refreshToggle() {
    var el = document.getElementById('filter-toggle');
    if (!el) return;
    var n = countSelected();
    var badge = el.querySelector('.filter-mega__count');
    if (badge) { badge.hidden = !n; if (n) badge.textContent = String(n); }
    el.classList.toggle('is-active', n > 0);
  }

  /** 面板内单个类别列:标题 + (标签多时)快速过滤框 + 复选框列表 */
  function buildColumn(cat) {
    var col = document.createElement('section');
    col.className = 'filter-mega__col';

    var head = document.createElement('h3');
    head.className = 'filter-mega__col-title';
    head.textContent = cat.name;
    col.appendChild(head);

    var list = document.createElement('div');
    list.className = 'filter-mega__list';

    function makeItem(tag) {
      var label = document.createElement('label');
      label.className = 'filter-mega__item';
      label.dataset.name = tag.name;
      // 检索串 = 规范名 + 别名,均归一化(全半角/空格/大小写折叠)→ 打"十点半"也能筛到"飞机场的10:30"
      label.dataset.search = ([tag.name].concat(tag.aliases || [])).map(function (n) {
        return window.TagText ? TagText.key(n) : String(n).toLowerCase().replace(/\s+/g, '');
      }).join(' ');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = tag.id;
      if (selectedTagsByCategory[cat.id] && selectedTagsByCategory[cat.id].has(tag.id)) cb.checked = true;
      cb.addEventListener('change', function () {
        if (!selectedTagsByCategory[cat.id]) selectedTagsByCategory[cat.id] = new Set();
        if (cb.checked) selectedTagsByCategory[cat.id].add(tag.id);
        else selectedTagsByCategory[cat.id].delete(tag.id);
        if (selectedTagsByCategory[cat.id].size === 0) delete selectedTagsByCategory[cat.id];
        afterFilterChange();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + tag.name));
      // 计数节点单独成 textNode → recomputeAvailability 可整体改写实时命中数,不碰 checkbox/dataset/名字
      var countNode = document.createTextNode(' (' + tag.count + ')');
      label.appendChild(countNode);
      filterItems.push({ catId: cat.id, tagId: tag.id, tag: tag, label: label, cb: cb, colEl: col, countText: countNode });
      return label;
    }
    (cat.tags || []).forEach(function (tag) { list.appendChild(makeItem(tag)); });

    if ((cat.tags || []).length > FILTER_SEARCH_THRESHOLD) {
      var search = document.createElement('input');
      search.className = 'filter-mega__search input';
      search.type = 'search';
      search.placeholder = '筛选' + cat.name;
      search.setAttribute('aria-label', '筛选' + cat.name);
      search.addEventListener('input', function () {
        // 列内快速过滤只改 q → 与可用性(avail)共用同一可见性判定
        for (var fi = 0; fi < filterItems.length; fi++) {
          if (filterItems[fi].colEl === col) applyVisibility(filterItems[fi]);
        }
      });
      col.appendChild(search);
    }

    col.appendChild(list);
    return col;
  }

  /** 全部筛选入口:单个「筛选」按钮 + 大面板,每类别一列并排 —— 可同时看清各列勾选;
   *  后续新增类别自动成列(兼容扩展)。数据仍由 selectedTagsByCategory + renderMap 驱动。 */
  function buildFilters() {
    var wrap = document.getElementById('filters');
    if (!wrap) return;
    wrap.innerHTML = '';
    filterItems.length = 0; // 重建前清空可用性注册表(防重复项)

    var root = document.createElement('div');
    root.className = 'filter-mega';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'filter-toggle';
    btn.className = 'filter-mega__toggle';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', '筛选');
    btn.title = '筛选';
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICON_PREFS + '</svg>' +
      '<span class="filter-mega__count" hidden></span>';

    var panel = document.createElement('div');
    panel.className = 'filter-mega__panel';
    panel.hidden = true;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '筛选');

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', String(!panel.hidden));
    });

    var cols = document.createElement('div');
    cols.className = 'filter-mega__cols';
    (tagCatalog.categories || []).forEach(function (cat) {
      if (!cat.tags || !cat.tags.length) return;
      cols.appendChild(buildColumn(cat));
    });
    panel.appendChild(cols);

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'filter-mega__clear';
    clearBtn.textContent = '清除筛选';
    clearBtn.addEventListener('click', function () {
      Object.keys(selectedTagsByCategory).forEach(function (k) { delete selectedTagsByCategory[k]; });
      var cbs = root.querySelectorAll('input[type="checkbox"]');
      Array.prototype.forEach.call(cbs, function (cb) { cb.checked = false; });
      afterFilterChange(); // 含 renderMap/refreshToggle/recomputeAvailability,年份条一并复位
    });
    panel.appendChild(clearBtn);

    root.appendChild(btn);
    root.appendChild(panel);
    wrap.appendChild(root);
    megaRoot = root;
    megaPanel = panel;
    refreshToggle();
  }

  /** 歌手页搜索接线(2026-09-09 v2,图标点开式):平时只显一枚放大镜;点图标 → 左旁展开透明无框输入
   *  并聚焦;输入防抖 180ms → 更新 searchQ → 重算可用性 + 重渲染(拼音组词中不触发,组词结束/回车立即)。
   *  × 清词不清开;Esc 有词先清词、空则收起;再点图标收起并还原。 */
  function bindSearch() {
    var box = document.getElementById('searchbox');
    var input = document.getElementById('perf-search');
    if (!box || !input) return; // 非歌手页(无搜索)no-op
    var clearBtn = document.getElementById('perf-search-clear');
    var toggle = document.getElementById('perf-search-toggle');
    var timer = null;
    function apply() {
      var q = (input.value || '').trim().toLowerCase();
      searchQ = q;
      if (clearBtn) clearBtn.hidden = q === '';
      recomputeAvailability(); // 搜索也算一维条件:列内实时计数/可用性随之收窄
      renderMap();
    }
    function setOpen(open) {
      input.hidden = !open;
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) input.focus();
    }
    function collapse() {
      input.value = '';
      apply();
      setOpen(false);
    }
    if (toggle) toggle.addEventListener('click', function () {
      if (input.hidden) { setOpen(true); apply(); } else collapse();
    });
    input.addEventListener('input', function (e) {
      if (e.isComposing) return;
      clearTimeout(timer);
      timer = setTimeout(apply, 180);
    });
    input.addEventListener('compositionend', function () { clearTimeout(timer); apply(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { clearTimeout(timer); apply(); }
      if (e.key === 'Escape') {
        if (input.value) { input.value = ''; apply(); } // 有词:先清词(保持展开)
        else collapse();                                // 空:收起
      }
    });
    if (clearBtn) clearBtn.addEventListener('click', function () { input.value = ''; apply(); input.focus(); });
  }

  function init() {
    buildFilters();
    mountYearBar(); // 年份条须在 buildFilters 之后:点条需同步面板 checkbox(filterItems)
    bindSearch();
    revealToolbar(); // 立即让工具条、搜索框与年份条就绪，无需等待 1MB 地图 SVG 解析
    renderMap();
    recomputeAvailability(); // 基线:无勾选 → 计数=接口基线,统一计数节点/可见性(顺带初始化 dataset.avail)
  }

  /** 顶部工具条(标签 + 搜索钮)与地图/页脚同帧淡入:搜索是静态 HTML,不 gate 会早于地图
   *  单独出现并跳位(2026-09-10)。标签由 buildFilters 同步append,与 is-ready 同帧。 */
  function revealToolbar() {
    var filters = document.getElementById('filters');
    if (filters) filters.classList.add('is-ready');
    var searchbox = document.getElementById('searchbox');
    if (searchbox) searchbox.classList.add('is-ready');
    var stats = document.getElementById('stats');
    if (stats) stats.classList.add('is-ready'); // 年份条与工具条同帧淡入,不早于筛选钮出现
  }

  // 工具条 + 地图 + footer 一起淡入,避免"中间后出 / 往下弹"
  function revealMap() {
    var loading = document.getElementById('map-loading');
    if (loading) loading.remove();
    revealToolbar();
    var map = document.getElementById('map');
    if (map) map.classList.add('is-ready');
    var foot = document.getElementById('site-foot');
    if (foot) foot.classList.add('is-ready');
    window.__appReady = true;
  }

  function showLoadError() {
    var el = document.getElementById('stats');
    if (el) el.textContent = '数据加载失败';
    var map = document.getElementById('map');
    if (map && !map.querySelector('.map-empty')) {
      var p = document.createElement('p');
      p.className = 'map-empty';
      p.textContent = '数据加载失败,请稍后刷新';
      map.appendChild(p);
    }
    revealMap();
  }

  var isUnknownSinger = false;

  /** 未知歌手:友好空态,不渲染空白地图;title/description 同步 */
  function showSingerNotFound() {
    isUnknownSinger = true;
    document.title = '该歌手尚未收录 · 现场档案馆';
    var metaDesc = document.getElementById('meta-description');
    if (metaDesc) metaDesc.setAttribute('content', '该歌手尚未收录。欢迎在首页请求新增歌手。');
    var loading = document.getElementById('map-loading');
    if (loading) loading.remove();
    revealToolbar();
    var map = document.getElementById('map');
    if (map) {
      var p = document.createElement('p');
      p.className = 'map-empty';
      var span = document.createElement('span');
      span.appendChild(document.createTextNode('该歌手尚未收录,去'));
      var a = document.createElement('a');
      a.href = '/';
      a.textContent = '返回首页';
      span.appendChild(a);
      span.appendChild(document.createTextNode('看看其他歌手,或在首页「+」请求新增。'));
      p.appendChild(span);
      map.appendChild(p);
      map.classList.add('is-ready');
    }
    var foot = document.getElementById('site-foot');
    if (foot) foot.classList.add('is-ready');
    window.__appReady = true;
  }

  /** 歌手页数据:标签计数按歌手过滤(仅该歌手),不传 ?singer= 保持全库 */
  function loadData() {
    var perfUrl = singer ? '/api/performances?singer=' + encodeURIComponent(singer) : '/api/performances';
    var tagsUrl = singer ? '/api/tags?singer=' + encodeURIComponent(singer) : '/api/tags';
    Promise.all([
      fetch(perfUrl).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch(tagsUrl).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    ]).then(function (results) {
      if (isUnknownSinger) return;
      all = results[0] || [];
      tagCatalog = results[1] || { categories: [] };
      applyYearDeepLink(); // ?year=YYYY 预置年份标签(buildFilters 之前,勾选态与筛选一次到位)
      init();
      // 提前整批预取本歌手全部演出的 reaction 计数 → 弹窗打开时反应条与其它 UI 同帧出现
      if (window.Modal && window.Modal.prefetchReactions && all.length) {
        window.Modal.prefetchReactions(all.map(function (i) { return i.id; }));
      }
      // 收藏态预热:把数据里 favorited=true 的 id 灌入 _fav(会话内真源;重开弹窗星态一致)
      if (window.Modal && window.Modal.prefetchFavorites && all.length) {
        window.Modal.prefetchFavorites(all);
      }
      // 深链 ?perf=(收藏卡 title 跳回):数据就绪后按演出 id 在**全量 all** 里找到那一场,
      // 再反查它此刻所处的城市 → 弹该城弹窗并定位到那一场(Modal.open 第二参)。
      // 权威是 perf(演出 id),城市由演出反查 —— 不信任 URL/收藏记录里的城市副本,
      // 演出被审核改过城市时链接自愈而不是退化到旧城(任务 09-13 决策 D1/R2)。
      // 打开成功即 replaceState **只剥掉 perf**(防刷新重复弹、防 Esc 后 URL 残留误导)。
      // 只删 perf 而保留其余参数:否则 ?year=2014&perf=… 会把 year 一并抹掉,刷新即丢年份筛选。
      // perf 不存在(被驳回/删除/未过审)或非法值 → no-op:不弹窗、不报错、不改 URL。
      var perfParam = new URLSearchParams(location.search).get('perf');
      if (perfParam) {
        var perfHit = null;
        for (var pi = 0; pi < all.length; pi++) {
          if (all[pi].id === perfParam) { perfHit = all[pi]; break; }
        }
        var perfCity = null;
        if (perfHit) {
          var cities = groupByCity(all);
          for (var ci = 0; ci < cities.length; ci++) {
            if (cities[ci].items.indexOf(perfHit) !== -1) { perfCity = cities[ci]; break; }
          }
        }
        if (perfCity) {
          window.Modal.open(perfCity, perfHit.id);
        }
      }
      // revealMap 由 render 的 onRendered 触发(地图渲染完才一起淡入)
    }).catch(showLoadError);
  }

  /** 歌手微简介跑马灯与快捷提交 */
  function mountSingerMicroIntros(container, singerObj) {
    var bar = document.createElement('div');
    bar.className = 'masthead__intros-bar';

    var viewport = document.createElement('div');
    viewport.className = 'masthead__intros-viewport no-mask';

    var track = document.createElement('div');
    track.className = 'intros-track';
    viewport.appendChild(track);
    bar.appendChild(viewport);

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'intro-chip intro-chip--add';
    addBtn.title = '为 ' + singerObj.name_zh + ' 补充一句话简介';
    addBtn.setAttribute('aria-label', addBtn.title);
    addBtn.innerHTML = '<span class="intro-chip__plus">+</span> 补充一句';
    bar.appendChild(addBtn);

    container.appendChild(bar);

    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderChips(intros) {
      track.innerHTML = '';
      var items = intros && intros.length ? intros : null;
      if (!items) {
        if (singerObj.intro) {
          var offChip = document.createElement('div');
          offChip.className = 'intro-chip intro-chip--official';
          offChip.innerHTML = '<span class="intro-chip__text">' + esc(singerObj.intro) + '</span><span class="intro-chip__author">官方简介</span>';
          track.appendChild(offChip);
        }
        viewport.classList.add('no-mask');
        track.classList.remove('intros-track--marquee');
        return;
      }

      items.forEach(function (it) {
        var chip = document.createElement('div');
        chip.className = 'intro-chip';
        chip.innerHTML = '<span class="intro-chip__text">' + esc(it.content) + '</span>' +
          '<span class="intro-chip__author">by @' + esc(it.submitter_name || '歌友') + '</span>';
        track.appendChild(chip);
      });

      if (items.length > 3) {
        items.forEach(function (it) {
          var clone = document.createElement('div');
          clone.className = 'intro-chip';
          clone.setAttribute('aria-hidden', 'true');
          clone.innerHTML = '<span class="intro-chip__text">' + esc(it.content) + '</span>' +
            '<span class="intro-chip__author">by @' + esc(it.submitter_name || '歌友') + '</span>';
          track.appendChild(clone);
        });
        track.classList.add('intros-track--marquee');
        viewport.classList.remove('no-mask');
      } else {
        track.classList.remove('intros-track--marquee');
        viewport.classList.add('no-mask');
      }
    }

    fetch('/api/singer-intros?singer=' + encodeURIComponent(singerObj.id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.intros && data.intros.length) {
          renderChips(data.intros);
        } else {
          renderChips(null);
        }
      })
      .catch(function () {
        renderChips(null);
      });

    addBtn.addEventListener('click', function () {
      if (!window.Auth) return;
      Auth.me().then(function (u) {
        if (!u) {
          if (window.AppDialog && AppDialog.confirm) {
            AppDialog.confirm({
              title: '需要登录',
              message: '登录后即可为歌手提交微简介（限10字以内），是否前往登录？',
              confirmText: '去登录'
            }).then(function (ok) {
              if (ok) window.location.href = '/profile';
            });
          } else {
            window.location.href = '/profile';
          }
          return;
        }
        if (window.AppDialog && AppDialog.prompt) {
          AppDialog.prompt({
            title: '为 ' + singerObj.name_zh + ' 补充一句话简介',
            message: '请输入简短评价或标签（不超过 10 个字，每人限 1 条）：',
            placeholder: '如：华语 R&B 教父',
            confirmText: '提交审核'
          }).then(function (val) {
            if (val === null) return;
            var trimmed = String(val).trim();
            if (!trimmed) {
              AppDialog.toast('简介内容不能为空', { type: 'warning' });
              return;
            }
            if (trimmed.length > 10) {
              AppDialog.toast('简介最多 10 个字，当前 ' + trimmed.length + ' 字', { type: 'error' });
              return;
            }
            Auth.request('POST', '/api/singer-intros', { singer_id: singerObj.id, content: trimmed })
              .then(function (res) {
                if (res.ok) {
                  AppDialog.toast('已提交微简介，审核通过后将在此展示', { type: 'success' });
                } else {
                  AppDialog.alert((res.data && res.data.error) ? res.data.error : '提交失败', { title: '提示' });
                }
              });
          });
        }
      });
    });
  }

  function applySingerMeta(s) {
    if (!s) return;
    var nameEl = document.getElementById('singer-name');
    var label = s.name_zh + (s.name_en ? ' · ' + s.name_en : '');
    if (nameEl) {
      nameEl.textContent = label + ' 全部演出';
      if (window.Icons && !nameEl.parentNode.querySelector('.singer-crumb__pin')) {
        var pinKey = 'preferred_masthead_singer';
        var getIsPinned = function () {
          try { return localStorage.getItem(pinKey) === s.id; } catch (e) { return false; }
        };
        var pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        var updatePinBtn = function () {
          var isP = getIsPinned();
          pinBtn.className = 'ghost-icon-btn singer-crumb__pin' + (isP ? ' is-pinned' : '');
          pinBtn.title = isP ? '已设为首页置顶（点击取消置顶）' : '设为首页置顶歌手';
          pinBtn.setAttribute('aria-label', pinBtn.title);
          pinBtn.setAttribute('aria-pressed', isP ? 'true' : 'false');
          pinBtn.innerHTML = isP ? Icons.get('pinFilled') : Icons.get('pin');
        };
        updatePinBtn();
        pinBtn.addEventListener('click', function () {
          try {
            if (getIsPinned()) localStorage.removeItem(pinKey);
            else localStorage.setItem(pinKey, s.id);
          } catch (e) {}
          updatePinBtn();
        });
        nameEl.parentNode.appendChild(pinBtn);
      }
    }
    document.title = label + ' · 现场档案馆';
    var metaDesc = document.getElementById('meta-description');
    if (metaDesc) {
      metaDesc.setAttribute('content', label + '演出全纪录地图:演唱会 / 音乐节 / 现场视频、照片、剪辑的聚合档案。');
    }
    var introEl = document.getElementById('singer-intro');
    if (introEl && !introEl.hasChildNodes()) {
      introEl.hidden = false;
      introEl.innerHTML = '';
      mountSingerMicroIntros(introEl, s);
    }
  }

  /** 歌手存在性 + intro/title/description 动态化 */
  function loadSingerMeta() {
    // 1) 优先从 sessionStorage 同步提取(若来自首页,零网络即可立即呈现标题与头像,0ms 秒开)
    var cachedList = null;
    try { cachedList = JSON.parse(sessionStorage.getItem('all_singers') || 'null'); } catch (e) {}
    if (Array.isArray(cachedList)) {
      var hit = cachedList.filter(function (x) { return x.id === singer; })[0];
      if (hit) applySingerMeta(hit);
    }

    // 2) 异步获取或校验最新元数据
    return fetch('/api/singers').then(function (r) { return r.json(); }).then(function (list) {
      var s = list.filter(function (x) { return x.id === singer; })[0];
      if (!s) { showSingerNotFound(); return false; }
      applySingerMeta(s);
      return true;
    }).catch(function () { return true; }); // 歌手列表加载失败 → 仍按原逻辑渲染地图
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (window.Auth) Auth.renderAuthLink(document.getElementById('auth-link'));
    // 提前开始下载 1MB 的 world.svg,与 /api 请求并行,消除地图"慢一拍"
    if (window.DTMap && window.DTMap.prefetch) window.DTMap.prefetch('/images/world.svg');
    if (singer) {
      // 并行请求歌手元信息与演出/标签数据，消灭串行等待瀑布流（提速约 200ms）
      loadSingerMeta();
      loadData();
    } else {
      loadData();
    }

    // 点击面板外部 / Esc → 关闭大下拉(仅一处全局监听)
    document.addEventListener('click', function (e) {
      if (megaRoot && !megaRoot.contains(e.target)) closeMega();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMega();
    });
  });
})();
