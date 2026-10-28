/* submit.js —— 提交页:新建 / 编辑 own pending(?edit=) / 建议修改已审核(?draft=)
 * 坐标:选城市自动填(服务器城市库 /api/cities);不在库城市失焦由服务器端
 * geocode 兜底;或手动填经纬度。
 * 标签:按类别选已有 approved 标签(类型/年份为自动标签,不出现在选择器);可提议新标签。 */

(function () {
  'use strict';

  /** 城市坐标状态机(不再前端硬编码城市库,数据来自 GET /api/cities):
   *  cityMap         /api/cities → {cityText: {lat,lng}}(精确匹配,大小写敏感)
   *  cityFilledFrom  上次自动填坐标对应的城市文本(含 geocode)
   *  coordsTouched   手动改坐标 / 📍 / edit·draft 回填 → true,blur 不再 geocode 覆盖
   *  geoInFlight     正在进行的 geocode q,用于拦截迟到响应 */
  var cityMap = {};
  var cityFilledFrom = '';
  var coordsTouched = false;
  var geoInFlight = '';

  /** 手动接管坐标:编辑 f-lat/f-lng 后,blur 不再用 geocode 覆盖 */
  function markCoordsManual() {
    coordsTouched = true;
    cityFilledFrom = '';
    var g = q('geo-msg');
    if (g) g.hidden = true; // 用户已手动接管,解析提示不再适用
  }

  /** GET /api/cities → datalist option + cityMap(精确匹配 lookup)。
   *  失败 → cityMap 空,自动填全靠 blur-geocode,仍可手填(不阻塞)。 */
  function loadCities() {
    var dl = q('city-datalist');
    if (!dl) return;
    fetch('/api/cities').then(function (r) { return r.json(); }).then(function (d) {
      var list = (d && d.cities) || [];
      cityMap = {};
      list.forEach(function (item) {
        cityMap[item.city] = { lat: item.lat, lng: item.lng };
        var o = document.createElement('option');
        o.value = item.city;
        dl.appendChild(o);
      });
    }).catch(function () {});
  }

  var catalog = { categories: [] };
  var selectedTagIds = {}; // tagId -> true
  var singerCache = [];    // active singers(GET /api/singers)

  /** 歌曲:独立选填入口(不走通用 chips/提议框,防双入口)。 */
  var SONG_CATEGORY = '歌曲';
  var songCatId = null;    // approved「歌曲」类别 id(/api/tags 仅回 approved 类别)
  var approvedSongs = [];  // [{id,name}] 当前歌手已收录歌(建议数据 + 直连命中)
  var loadedSinger = '';   // v6:当前建议对应的歌手(loadCatalog 设置;歌手变化对比用)

  function q(s) { return document.getElementById(s); }

  /** 歌手选择器:GET /api/singers(active)填充;从 /submit?singer={id} 进入时预选。
   *  返回 Promise,保证 loadRow 回填 singer 时下拉已就绪(edit/draft 模式)。 */
  function loadSingers(preselectId) {
    var sel = q('f-singer');
    if (!sel) return Promise.resolve();
    sel.innerHTML = '<option value="">加载歌手…</option>';
    return fetch('/api/singers').then(function (r) { return r.json(); }).then(function (list) {
      singerCache = list || [];
      sel.innerHTML = '';
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '';
      sel.appendChild(ph);
      singerCache.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name_zh + (s.name_en ? ' · ' + s.name_en : '');
        sel.appendChild(o);
      });
      var req = document.createElement('option');
      req.value = '__request__';
      req.textContent = '请求新增歌手…';
      sel.appendChild(req);

      var lastSubmitted = null;
      try { lastSubmitted = localStorage.getItem('last_submitted_singer'); } catch (e) {}
      var preferred = null;
      try { preferred = localStorage.getItem('preferred_masthead_singer'); } catch (e) {}

      // 默认歌手优先级: URL参数 > 上一次提交的歌手 > 首页标记/置顶的歌手 > 留空(不默认陶喆)
      var targetId = '';
      if (preselectId && singerCache.some(function (s) { return s.id === preselectId; })) {
        targetId = preselectId;
      } else if (lastSubmitted && singerCache.some(function (s) { return s.id === lastSubmitted; })) {
        targetId = lastSubmitted;
      } else if (preferred && singerCache.some(function (s) { return s.id === preferred; })) {
        targetId = preferred;
      }

      if (targetId) {
        sel.value = targetId;
      } else {
        sel.value = '';
      }
      syncSubmitSteps();

      // 若本地未记录 last_submitted_singer 且无 URL 预选,尝试从用户的提交历史异步补充对齐
      if (!preselectId && !lastSubmitted) {
        fetch('/api/my-submissions').then(function (r) {
          return r.ok ? r.json() : [];
        }).then(function (subs) {
          if (Array.isArray(subs) && subs.length) {
            var sorted = subs.slice().sort(function (a, b) {
              return (b.created_at || '').localeCompare(a.created_at || '') || (b.id || '').localeCompare(a.id || '');
            });
            var recentSinger = sorted[0] && sorted[0].singer;
            if (recentSinger && singerCache.some(function (s) { return s.id === recentSinger; })) {
              try { localStorage.setItem('last_submitted_singer', recentSinger); } catch (e) {}
              // 用户在拉取期间未手动改选(仍为空或当时回退选中的首页歌手)时,更新为上一次提交的歌手
              if (!sel._userChanged && (!sel.value || sel.value === preferred)) {
                sel.value = recentSinger;
                loadCatalog();
                syncSubmitSteps();
              }
            }
          }
        }).catch(function () {});
      }
    }).catch(function () {
      sel.innerHTML = '<option value="">歌手加载失败,请刷新重试</option>';
    });
  }

  /* ---- 整场视频逐曲时间轴(2026-09-07):整场链接行下可展开"歌名+开始秒"表 ----
   * 规则:一场至多一条整场链接(is_full radio 语义);整场开关仅对 bilibili 链接开放;
   * 一旦勾选整场,顶部歌曲框让位(本行逐曲表成为曲目来源);歌名列复用"已收录点选/新歌填"。
   * 时间可留空(=唱过但没有跳转点);表内全部为空行 = 退化为普通链接(不落 is_full)。 */

  /** 建一行逐曲输入。part 缺省沿用「上一行 part 或 1」(手动续加某 P 时继续;2026-09-09 bili-multipart)。
   *  行元素记 data-part;多 P 组(存在 part>1)才渲染 P 徽,单 P 组无徽(视觉与 v10 一致)。 */
  function makeTrackRow(editor, name, timeText, part) {
    var wrap = editor.querySelector('.track-rows');
    var rows = wrap.querySelectorAll('.track-row');
    var lastPart = rows.length ? Number(rows[rows.length - 1].getAttribute('data-part') || 1) : 1;
    if (part == null) part = lastPart;
    part = Number(part);
    if (!Number.isInteger(part) || part < 1) part = 1;
    if (part > 999) part = 999;
    var div = document.createElement('div');
    div.className = 'track-row';
    div.setAttribute('data-part', String(part));
    div.innerHTML =
      '<input class="input track-name" list="approved-songs" placeholder="歌名" maxlength="50" value="' + Auth.esc(name || '') + '">' +
      '<span class="part-badge" aria-hidden="true"></span>' +
      '<input class="input track-time" placeholder="时间 (mm:ss)" maxlength="8" value="' + Auth.esc(timeText || '') + '">' +
      '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger track-rm" title="删除此行" aria-label="删除此行">' +
        (window.Icons ? Icons.get('delete') : '删') +
      '</button>';
    var timeInput = div.querySelector('.track-time');
    timeInput.addEventListener('blur', function () {
      var v = this.value.trim();
      var r = v ? window.TrackTime.parse(v) : null;
      this.classList.toggle('invalid', !!(r && r.err));
    });
    div.querySelector('.track-name').addEventListener('input', function () { syncTrackChipVisibility(editor); });
    div.querySelector('.track-rm').addEventListener('click', function () { wrap.removeChild(div); syncPartBadges(editor); syncTrackChipVisibility(editor); });
    wrap.appendChild(div);
    syncPartBadges(editor);
    syncTrackChipVisibility(editor);
    return div;
  }

  /** 同步整组 P 徽:存在 part>1(多 P)→ 每行时间前显示 P<n>;否则全部隐藏(单 P 视觉不变)。 */
  function syncPartBadges(editor) {
    var rows = editor.querySelectorAll('.track-row');
    var multi = false;
    for (var i = 0; i < rows.length; i++) {
      if (Number(rows[i].getAttribute('data-part') || 1) > 1) { multi = true; break; }
    }
    for (var j = 0; j < rows.length; j++) {
      var badge = rows[j].querySelector('.part-badge');
      if (!badge) continue;
      if (multi) {
        badge.textContent = 'P' + (Number(rows[j].getAttribute('data-part') || 1));
        badge.classList.add('show');
      } else {
        badge.textContent = '';
        badge.classList.remove('show');
      }
    }
  }

  function renderTrackChips(editor) {
    var chipsWrap = editor.querySelector('.track-chips');
    if (!chipsWrap) return;
    chipsWrap.innerHTML = '';
    if (!approvedSongs.length) return;
    approvedSongs.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tag-chip';
      b.textContent = t.name;
      b.setAttribute('data-name', t.name);
      b.title = '已收录歌,点一下加一行(时间可留空)';
      b.addEventListener('click', function () {
        var existing = null;
        var rows = editor.querySelectorAll('.track-row');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].querySelector('.track-name').value.trim() === t.name) { existing = rows[i]; break; }
        }
        if (existing) { var ti = existing.querySelector('.track-time'); if (ti) ti.focus(); return; }
        makeTrackRow(editor, t.name, '');
      });
      chipsWrap.appendChild(b);
    });
    syncTrackChipVisibility(editor); /* 表里已存在的歌,其芯片自动不显示 */
  }

  /** 已收录芯片与逐曲行联动:行内歌名(trim)命中某芯片 → 该芯片加 .used(CSS 隐藏),
   *  填完/粘完整段歌单后,上方已收录区不再列出已在表里的歌;删行或改名自动恢复。 */
  function syncTrackChipVisibility(editor) {
    var chipsWrap = editor.querySelector('.track-chips');
    if (!chipsWrap) return;
    var names = {};
    var nameInputs = editor.querySelectorAll('.track-row .track-name');
    for (var i = 0; i < nameInputs.length; i++) {
      var v = nameInputs[i].value.trim();
      if (v) names[v] = true;
    }
    var chips = chipsWrap.querySelectorAll('.tag-chip');
    for (var j = 0; j < chips.length; j++) {
      var n = chips[j].getAttribute('data-name') || '';
      chips[j].classList.toggle('used', !!(n && names[n]));
    }
  }

  /** 开关整场:on → 互斥其余行 + 展开本行逐曲编辑器;off → 收起。数据保留(DOM 不清)。 */
  function setWhole(div, on) {
    var chk = div.querySelector('.link-whole-check');
    var editor = div.querySelector('.track-editor');
    if (on) {
      var all = document.querySelectorAll('#link-rows .link-row .link-whole-check');
      for (var i = 0; i < all.length; i++) {
        if (all[i] !== chk) { all[i].checked = false; var e = all[i].closest('.link-row').querySelector('.track-editor'); if (e) e.hidden = true; }
      }
      chk.checked = true;
      editor.hidden = false;
      renderTrackChips(editor);
      if (!editor.querySelector('.track-row')) makeTrackRow(editor, '', '');
    } else {
      chk.checked = false;
      editor.hidden = true;
    }
    syncSongMode();
  }

  /** 模式互斥:任一整场开关 ON → 顶部歌曲框让位(逐曲表即曲目来源) */
  function syncSongMode() {
    var box = q('songs-editor');
    var any = false;
    var rows = q('link-rows').querySelectorAll('.link-row');
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].querySelector('.link-whole-check');
      if (c && c.checked) { any = true; break; }
    }
    if (box) box.hidden = any;
  }

  /** 当前勾选的整场链接行(radio 语义至多一个);无则 null */
  function engagedRow() {
    var rows = q('link-rows').querySelectorAll('.link-row');
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].querySelector('.link-whole-check');
      if (c && c.checked) return rows[i];
    }
    return null;
  }

  /** 已收录曲库贪心前缀匹配:如果输入字符串以某已收录标准歌名开头且后接分隔符/备注/噪音,自动截取标准歌名 */
  function matchKnownSong(raw) {
    if (!raw || !approvedSongs || !approvedSongs.length) return null;
    var s = String(raw).trim();
    for (var i = 0; i < approvedSongs.length; i++) {
      var song = approvedSongs[i].name;
      if (!song) continue;
      if (s === song) return song;
      if (s.indexOf(song) === 0) {
        var rest = s.slice(song.length);
        if (/^[\s\-_/|—–（\(\[【「]/.test(rest)) {
          return song;
        }
      }
    }
    return null;
  }

  /** 读取整场编辑器每行 → [{name, timeStr, parsed, part}] */
  function readTrackRows(editor) {
    var out = [];
    var rows = editor.querySelectorAll('.track-row');
    for (var i = 0; i < rows.length; i++) {
      var rawName = rows[i].querySelector('.track-name').value.trim();
      var cleaned = (window.TrackTime && window.TrackTime.cleanSongName) ? window.TrackTime.cleanSongName(rawName) : rawName;
      var name = matchKnownSong(cleaned) || matchKnownSong(rawName) || cleaned;
      var timeStr = rows[i].querySelector('.track-time').value.trim();
      var parsed = timeStr ? window.TrackTime.parse(timeStr) : { sec: null, err: false };
      var part = Number(rows[i].getAttribute('data-part') || 1);
      if (!Number.isInteger(part) || part < 1) part = 1;
      if (part > 999) part = 999;
      out.push({ name: name, timeStr: timeStr, parsed: parsed, part: part });
    }
    return out;
  }

  /** 整场逐曲表校验 → 错误文案或 ''(保存前拦,不发后端正则 400) */
  function validateTracks() {
    var row = engagedRow();
    if (!row) return '';
    var url = row.querySelector('.link-url').value.trim();
    if (!window.TrackTime.isBilibili(url)) return '整场视频链接须为 bilibili 链接(改回网址,或取消下方"整场长视频"勾选)';
    var items = readTrackRows(row.querySelector('.track-editor'));
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.timeStr && it.parsed.err) return '第 ' + (i + 1) + ' 行时间格式应为 m:ss 或 h:mm:ss';
      if (!it.name && it.timeStr) return '第 ' + (i + 1) + ' 行有开始时间但没填歌名';
    }
    return '';
  }

  /** 是否已填任何歌曲内容(顶部框 / 整场勾选 / 逐曲表任意行) */
  function hasSongInput() {
    var f = q('f-songs');
    if (f && f.value.trim()) return true;
    var links = q('link-rows').querySelectorAll('.link-row');
    for (var i = 0; i < links.length; i++) {
      var chk = links[i].querySelector('.link-whole-check');
      if (chk && chk.checked) return true;
      var rows = links[i].querySelectorAll('.track-row');
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].querySelector('.track-name').value.trim() || rows[j].querySelector('.track-time').value.trim()) return true;
      }
    }
    return false;
  }

  /** 是否已有「实际歌名」内容(顶部歌曲框文本 / 逐曲表任一行有歌名或时间)。
   *  整场勾选本身或空壳逐曲行不算 —— 供「解析自动预填」判断是否可安全自动选歌手(不误伤空整场)。 */
  function hasSongText() {
    var f = q('f-songs');
    if (f && f.value.trim()) return true;
    var links = q('link-rows').querySelectorAll('.link-row');
    for (var i = 0; i < links.length; i++) {
      var rows = links[i].querySelectorAll('.track-row');
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].querySelector('.track-name').value.trim() || rows[j].querySelector('.track-time').value.trim()) return true;
      }
    }
    return false;
  }

  /** 清空歌曲输入:顶部歌曲框 + 各整场逐曲表行并收起整场(切歌手用,先 confirm 再调) */
  function clearSongInput() {
    var f = q('f-songs');
    if (f) f.value = '';
    var links = q('link-rows').querySelectorAll('.link-row');
    for (var i = 0; i < links.length; i++) {
      var rows = links[i].querySelectorAll('.track-rows');
      for (var j = 0; j < rows.length; j++) rows[j].innerHTML = '';
      var chk = links[i].querySelector('.link-whole-check');
      if (chk && chk.checked) setWhole(links[i], false);
    }
    syncSongChips();
  }

  /** 提交页分步状态机 (方案 A: Step Cards + Progress Pills) */
  function syncSubmitSteps() {
    var step1Btn = document.querySelector('.submit-step[data-step="1"]');
    var step2Btn = document.querySelector('.submit-step[data-step="2"]');
    var step3Btn = document.querySelector('.submit-step[data-step="3"]');
    if (!step1Btn || !step2Btn || !step3Btn) return;

    // Step 1: 视频来源 — 至少有一行填了有效 URL
    var linkRows = q('link-rows') ? q('link-rows').querySelectorAll('.link-row') : [];
    var step1Ok = false;
    for (var i = 0; i < linkRows.length; i++) {
      var u = linkRows[i].querySelector('.link-url');
      if (u && u.value.trim()) { step1Ok = true; break; }
    }

    // Step 2: 演出档案 — 歌手、标题、年份、形式、城市、坐标
    var sVal = q('f-singer') ? q('f-singer').value : '';
    var tVal = q('f-title') ? q('f-title').value.trim() : '';
    var yVal = q('f-year') ? q('f-year').value.trim() : '';
    var typeVal = q('f-type') ? q('f-type').value : '';
    var cVal = q('f-city') ? q('f-city').value.trim() : '';
    var latVal = q('f-lat') ? q('f-lat').value.trim() : '';
    var lngVal = q('f-lng') ? q('f-lng').value.trim() : '';
    var step2Ok = !!(sVal && sVal !== '__request__' && tVal && yVal && typeVal && cVal && latVal && lngVal);

    // Step 3: 曲目与标签 — 选填，有任何输入即算完成
    var step3Ok = (typeof hasSongInput === 'function' && hasSongInput()) || (selectedTagIds && Object.keys(selectedTagIds).length > 0);

    function applyStepState(btn, num, isCompleted) {
      btn.classList.toggle('completed', isCompleted);
      var numEl = btn.querySelector('.submit-step__num');
      if (numEl) numEl.textContent = isCompleted ? '✓' : String(num);
    }

    applyStepState(step1Btn, 1, step1Ok);
    applyStepState(step2Btn, 2, step2Ok);
    applyStepState(step3Btn, 3, step3Ok);
  }

  function addLinkRow(label, url, placeholder, is_full, tracks) {
    var rows = q('link-rows');
    var div = document.createElement('div');
    div.className = 'link-row';
    var bili = window.TrackTime.isBilibili(url || '');
    div.innerHTML =
      '<div class="link-row__main">' +
        '<img class="link-row__thumb" alt="" hidden>' +
        '<input class="input link-label" placeholder="标签 (如 全场录像)" maxlength="100" value="' + Auth.esc(label || '') + '">' +
        '<input class="input link-url" placeholder="视频链接 (支持 B 站分享文本)" maxlength="200" value="' + Auth.esc(url || '') + '">' +
        '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger link-rm" title="清空内容" aria-label="清空内容">' +
          (window.Icons ? Icons.get('delete') : '删') +
        '</button>' +
      '</div>' +
      '<label class="link-whole">' +
        '<input type="checkbox" class="link-whole-check"' + (bili ? '' : ' disabled') + ' title="仅 B站视频支持逐曲秒跳">' +
        '<span>整场长视频（逐曲时间轴）</span>' +
      '</label>' +
      '<div class="track-editor" hidden>' +
        '<div class="list-paste">' +
          '<button type="button" class="linkish list-paste-toggle">粘贴整段歌单(每行:时间+空格+歌名,或歌名+空格+时间;多 P 用独立行 p2/p3 切分)</button>' +
          '<div class="list-paste__body" hidden>' +
            '<textarea class="input list-paste-text" rows="8" spellcheck="false" placeholder="00:00 找自己\n就是爱你 05:00\n爱很简单 10:00"></textarea>' +
            '<div class="list-paste__row">' +
              '<button type="button" class="btn btn--ghost btn--sm list-paste-go">填入上表</button>' +
              '<span class="list-paste-msg form-note" role="status"></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="track-pick">' +
          '<div class="track-chips tag-chips"></div>' +
        '</div>' +
        '<div class="track-rows"></div>' +
        '<button type="button" class="btn btn--ghost btn--sm track-add">+ 加一首</button>' +
      '</div>';

    var chk = div.querySelector('.link-whole-check');
    var editor = div.querySelector('.track-editor');
    var urlInput = div.querySelector('.link-url');
    var labelInput = div.querySelector('.link-label');
    var rmBtn = div.querySelector('.link-rm');

    function isLinkRowEmpty() {
      var u = (urlInput && urlInput.value.trim()) || '';
      var l = (labelInput && labelInput.value.trim()) || '';
      var w = chk && chk.checked;
      var hasTracks = false;
      var trackInputs = editor.querySelectorAll('.track-row input');
      for (var ti = 0; ti < trackInputs.length; ti++) {
        if (trackInputs[ti].value.trim()) { hasTracks = true; break; }
      }
      return !u && !l && !w && !hasTracks;
    }

    function clearLinkRow() {
      if (urlInput) { urlInput.value = ''; urlInput.classList.remove('invalid'); }
      if (labelInput) labelInput.value = '';
      setRowCover(div, '');
      delete div.dataset.pasteTitle;
      div._pasteCanonical = '';
      if (chk) {
        if (chk.checked) setWhole(div, false);
        chk.disabled = true;
      }
      var trackRows = editor.querySelector('.track-rows');
      if (trackRows) trackRows.innerHTML = '';
      syncSongMode();
      updateRmTitle();
    }

    function updateRmTitle() {
      var allRows = rows.querySelectorAll('.link-row');
      var isLast = allRows.length <= 1;
      var isEmpty = isLinkRowEmpty();
      var tip = (isLast || !isEmpty) ? '清空内容' : '删除该行';
      rmBtn.title = tip;
      rmBtn.setAttribute('aria-label', tip);
    }

    rmBtn.addEventListener('click', function () {
      var allRows = rows.querySelectorAll('.link-row');
      if (allRows.length <= 1) {
        clearLinkRow();
        return;
      }
      if (!isLinkRowEmpty()) {
        clearLinkRow();
      } else {
        rows.removeChild(div);
        syncSongMode();
      }
    });

    chk.addEventListener('change', function () { setWhole(div, this.checked); updateRmTitle(); });
    urlInput.addEventListener('input', function () {
      var ok = window.TrackTime.isBilibili(this.value);
      chk.disabled = !ok;
      if (!ok && chk.checked) setWhole(div, false); // 改成非 bilibili → 收起整场(行内数据保留)
      // 用户改回裸 URL / 改动 canonical → 旧粘贴标题不再可靠,清除防残留
      if (this.value !== (div._pasteCanonical || '')) {
        delete div.dataset.pasteTitle;
        div._pasteCanonical = '';
      }
      updateRmTitle();
    });
    labelInput.addEventListener('input', updateRmTitle);
    // R1 分享文字粘贴:URL 框接受整段「【标题】 链接?share_source…」→ 归 canonical + 存 pasteTitle
    urlInput.addEventListener('paste', function (e) {
      var text = '';
      try { text = (e.clipboardData && e.clipboardData.getData('text')) || ''; } catch (err) { text = ''; }
      if (!text) return; // 无剪贴板内容(罕见)→ 默认粘贴;input 监听负责清残留
      if (applySharePasteToRow(div, text)) e.preventDefault();
    });
    editor.querySelector('.track-add').addEventListener('click', function () { makeTrackRow(editor, '', ''); });
    // 整段粘贴歌单 → 解析成可编辑逐曲行(覆盖,先 confirm;2026-09-07)
    var pasteToggle = editor.querySelector('.list-paste-toggle');
    var pasteBody = editor.querySelector('.list-paste__body');
    var pasteText = editor.querySelector('.list-paste-text');
    var pasteMsg = editor.querySelector('.list-paste-msg');
    if (pasteToggle) {
      pasteToggle.addEventListener('click', function () {
        pasteBody.hidden = !pasteBody.hidden;
        // 每次展开清掉上一次状态消息,避免残留误导
        if (!pasteBody.hidden) pasteMsg.textContent = '';
      });
      editor.querySelector('.list-paste-go').addEventListener('click', function () {
        var res = window.TrackTime.parseList(pasteText.value);
        if (!res.rows.length) {
          // R8:0 行 → 面板保持展开,显示无法解析原因(逐曲行原样保留)
          pasteBody.hidden = false;
          pasteMsg.textContent = res.ignored.length
            ? '没有能解析的行(' + res.ignored.length + ' 行忽略,每行应为 时间+空格+歌名 或 歌名+空格+行尾时间)'
            : '请先粘贴歌单文本(每行:时间+空格+歌名,或歌名+空格+行尾时间)';
          return;
        }
        var has = false;
        var existing = editor.querySelectorAll('.track-row');
        for (var i = 0; i < existing.length; i++) {
          if (existing[i].querySelector('.track-name').value.trim() || existing[i].querySelector('.track-time').value.trim()) { has = true; break; }
        }
        var proceedImport = function () {
          editor.querySelector('.track-rows').innerHTML = '';
          res.rows.forEach(function (r) { makeTrackRow(editor, r.name, window.TrackTime.format(r.seconds), r.part); });
          pasteText.value = '';
          // R8:解析成功(≥1 行)→ 收起粘贴面板;逐曲行已填入上表可直接核对/修改
          pasteBody.hidden = true;
          pasteMsg.textContent = '';
        };

        if (has) {
          if (window.AppDialog) {
            AppDialog.confirm({
              title: '覆盖已有逐曲',
              message: '整段导入会覆盖当前已填写的逐曲列表，继续导入吗？',
              confirmText: '确认覆盖',
              danger: true
            }).then(function (ok) {
              if (ok) proceedImport();
            });
          } else if (window.confirm('整段导入会覆盖当前已填的逐曲行,继续吗?')) {
            proceedImport();
          }
        } else {
          proceedImport();
        }
      });
    }

    rows.appendChild(div);
    if (is_full) {
      setWhole(div, true);
      (tracks || []).forEach(function (t) {
        makeTrackRow(editor, t.name, t.seconds != null ? window.TrackTime.format(t.seconds) : '', t.part);
      });
      // 去掉 setWhole 预加的空壳行(回填有曲目时不保留空行);全空则留一行空行可填
      var trs = editor.querySelectorAll('.track-row');
      for (var k = trs.length - 1; k >= 0; k--) {
        var rr = trs[k];
        if (!rr.querySelector('.track-name').value.trim() && !rr.querySelector('.track-time').value.trim()) {
          rr.parentNode.removeChild(rr);
        }
      }
      if (!editor.querySelector('.track-row')) makeTrackRow(editor, '', '');
      syncPartBadges(editor);
      syncSongMode();
    }
    syncSubmitSteps();
  }

  function loadRow(r) {
    if (r.singer && q('f-singer').querySelector('option[value="' + Auth.esc(r.singer) + '"]')) {
      q('f-singer').value = r.singer;
    }
    q('f-title').value = r.title || '';
    q('f-year').value = r.year != null ? r.year : '';
    q('f-date').value = r.date || '';
    q('f-type').value = r.type || '演唱会';
    q('f-venue').value = r.venue || '';
    q('f-city').value = r.city || '';
    q('f-lat').value = r.lat != null ? r.lat : '';
    q('f-lng').value = r.lng != null ? r.lng : '';
    // 回填的已有坐标视为已确认 → blur 不再用 geocode 覆盖(edit/draft 模式)
    if ((r.lat != null && r.lat !== '') || (r.lng != null && r.lng !== '')) coordsTouched = true;
    // 回填的已有「形式」是已确认字段 → 解析预填不再自动改 type(R4/R7:只填空)
    if (r.type) typeTouched = true;
    q('f-note').value = r.note || '';
    var hasTracks = !!(r.tracks && r.tracks.length);
    (r.links || []).forEach(function (l) {
      addLinkRow(l.label, l.url, !!l.placeholder, !!l.is_full, l.is_full ? (r.tracks || []) : []);
    });
    // 原条目无链接 → 留一行可填;有链接则只回填(避免空行浮在已填链接上面)
    if (!(r.links || []).length) addLinkRow();
    // 回填已选非自动标签(歌曲走专属框、不入通用 chips)
    var songNames = [];
    (r.tags || []).forEach(function (t) {
      if (t.category_name === '类型' || t.category_name === '年份') return;
      if (t.category_name === SONG_CATEGORY) { songNames.push(t.name); return; }
      selectedTagIds[t.id] = true;
    });
    var songsEl = q('f-songs');
    // 有整场逐曲时间轴 → 顶部歌曲框隐藏且不预填(时间轴即曲目来源,避免双写);否则照旧回填
    if (songsEl && !hasTracks) { songsEl.value = songNames.join('、'); syncSongChips(); }
    renderPicker();
    // v6:编辑/建议修改的歌手在 loadCatalog 之后才回填 → 按其歌手补拉建议(芯片/datalist/逐曲芯片)
    if (r.singer) {
      var singerSel = q('f-singer');
      if (singerSel && singerSel.value === r.singer && loadedSinger !== r.singer) loadCatalog();
    }
    syncSubmitSteps();
  }

  function renderPicker() {
    var wrap = q('tag-picker');
    if (!wrap) return;
    wrap.innerHTML = '';
    var any = false;
    (catalog.categories || []).forEach(function (cat) {
      if (cat.name === '类型' || cat.name === '年份' || cat.name === SONG_CATEGORY) return;
      if (!cat.tags || !cat.tags.length) return;
      any = true;
      var group = document.createElement('div');
      group.className = 'tag-group';
      var name = document.createElement('span');
      name.className = 'tag-group__name';
      name.textContent = cat.name;
      group.appendChild(name);
      var chips = document.createElement('div');
      chips.className = 'tag-chips';
      (cat.tags || []).forEach(function (tag) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'tag-chip' + (selectedTagIds[tag.id] ? ' active' : '');
        b.textContent = tag.name;
        b.addEventListener('click', function () {
          if (selectedTagIds[tag.id]) delete selectedTagIds[tag.id];
          else selectedTagIds[tag.id] = true;
          b.classList.toggle('active');
          syncSubmitSteps();
        });
        chips.appendChild(b);
      });
      group.appendChild(chips);
      wrap.appendChild(group);
    });
    if (!any) wrap.innerHTML = '<p class="empty">暂无可用标签。</p>';
  }

  function renderProposeCategories() {
    var sel = q('propose-category');
    if (!sel) return;
    sel.innerHTML = '';
    (catalog.categories || []).forEach(function (cat) {
      if (cat.name === '类型' || cat.name === '年份' || cat.name === SONG_CATEGORY) return;
      var o = document.createElement('option');
      o.value = cat.id;
      o.textContent = cat.name;
      sel.appendChild(o);
    });
  }

  /** 歌曲点选(toggle,2026-09-07 恢复「已收录可点选」):已收录歌渲染成芯片,
   *  点一下把 canonical 名追加进歌曲框(active 高亮),再点一下把它从框里移除。
   *  移除按「字段=整首歌名」做,分隔统一成原样用换行或顿号,不残留空壳。 */
  function songNamesInBox() {
    var el = q('f-songs');
    if (!el) return [];
    return el.value.split(/[、\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function songNameInBox(name) {
    var list = songNamesInBox();
    for (var i = 0; i < list.length; i++) if (list[i] === name) return true;
    return false;
  }

  function addApprovedSong(name) {
    var el = q('f-songs');
    if (!el || songNameInBox(name)) return;
    var base = el.value.replace(/\s+$/, '');
    if (base && !/[、\n]$/.test(base)) base += '、';
    el.value = base + name;
    syncSongChips();
    el.focus();
  }

  function removeApprovedSong(name) {
    var el = q('f-songs');
    if (!el || !songNameInBox(name)) return;
    // 原框用过换行分隔 → 移除后仍用换行重排,否则用顿号;只删目标歌名,其它歌名保留
    var useNl = el.value.indexOf('\n') !== -1;
    var keep = el.value.split(/[、\n]/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s !== name; });
    el.value = keep.join(useNl ? '\n' : '、');
    syncSongChips();
    el.focus();
  }

  function syncSongChips() {
    var wrap = q('song-chips');
    if (wrap) {
      var btns = wrap.querySelectorAll('.tag-chip');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', songNameInBox(btns[i].getAttribute('data-name')));
      }
    }
    var f = q('f-songs');
    var hint = q('songs-timeline-hint');
    if (f && hint) {
      hint.hidden = !/(?:^|\n)\s*(?:\[|【|\()?\d{1,3}:[0-5]\d/.test(f.value);
    }
    syncSubmitSteps();
  }

  /** 已收录歌名 → 全局 datalist(逐曲表行内歌名 input 的自动补全) */
  function fillSongDatalist() {
    var dl = q('approved-songs');
    if (!dl) return;
    dl.innerHTML = '';
    approvedSongs.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.name;
      dl.appendChild(o);
    });
  }

  function renderSongChips() {
    var wrap = q('song-chips');
    if (!wrap) return;
    var pick = wrap.closest('.song-pick');
    wrap.innerHTML = '';
    if (!approvedSongs.length) { if (pick) pick.hidden = true; return; }
    if (pick) pick.hidden = false;
    approvedSongs.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tag-chip';
      b.setAttribute('data-name', t.name);
      b.title = '已收录歌,点一下加入;再点一下移除';
      b.textContent = t.name;
      b.addEventListener('click', function () {
        if (songNameInBox(t.name)) removeApprovedSong(t.name);
        else addApprovedSong(t.name);
      });
      wrap.appendChild(b);
    });
    syncSongChips();
  }

  /* ---- 视频链接解析 · 自动预填(2026-09-08 / 09-09 兜底):解析对象 = 提交表单「视频链接
   * (最多10条)」里的真链接。youtube → 在线 /api/video-meta;bilibili 带粘贴标题(【标题】分享文字)
   * → 本地零网络;bilibili 裸链接 → /api/video-meta(先查自身 video_meta 缓存,命中才零上游回 title;
   * 未收录才现抓——CF 出口已被 412 封)。预填只填空字段(不覆盖已填)+ 形式枚举匹配;歌手确定时对
   * 非整场链接 title 强信号匹配已收录曲目 → canonical 预填;随后弹「请检查」模态(许可门槛)。
   * 任何写库只在用户点提交时发生。 ---- */
  var parseBusy = false;
  /** 形式(演出类型)枚举(R4):标题命中唯一值才自动设 f-type;「其他」不作关键词 */
  var TYPE_LABELS = ['演唱会', '音乐节', '歌友会', '签售'];
  /** f-type 是否被用户碰过(change 置 true);预填不再覆盖用户手选 */
  var typeTouched = false;

  /** 本地归一:NFKC → 小写 → 去空白(与后端 tagKey 同向,供标题/歌名/歌手名子串匹配) */
  function nk(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFKC'); } catch (e) { /* 老引擎无 normalize,保持原样 */ }
    return t.toLowerCase().replace(/\s+/g, '');
  }

  /** 前端协议/白名单预检(不发请求直接跳过;后端同规则兜底) */
  function isAllowedVideoUrl(u) {
    if (!/^https?:\/\//i.test(u)) return false;
    var h;
    try { h = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
    if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return true;
    if (h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv' || h.endsWith('.b23.tv')) return true;
    return false;
  }

  /** 解析用白名单 provider 分类(youtube / bilibili / ''):分流决定走在线 /api/video-meta 还是本地粘贴标题(见 parseLinks) */
  function videoProvider(u) {
    if (!/^https?:\/\//i.test(u)) return '';
    var h;
    try { h = new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
    if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return 'youtube';
    if (h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv' || h.endsWith('.b23.tv')) return 'bilibili';
    return '';
  }

  function showLinksMsg(txt, isErr) {
    var msg = q('links-msg');
    if (!msg) return;
    msg.textContent = txt;
    msg.classList.toggle('err', !!isErr);
    msg.hidden = false;
  }

  /** 歌手 id → 展示名(用于预填摘要)。 */
  function singerNameById(id) {
    for (var i = 0; i < singerCache.length; i++) {
      if (singerCache[i].id === id) {
        var n = singerCache[i].name_zh || '';
        if (singerCache[i].name_en) n = n ? n + ' · ' + singerCache[i].name_en : singerCache[i].name_en;
        return n || id;
      }
    }
    return id;
  }

  /** 标题文本里唯一命中 active singer(name_zh/name_en 作 nk 子串)才选;0 或多个 → '' */
  function inferSingerId(allTextNk) {
    if (!singerCache.length || !allTextNk) return '';
    var hits = [];
    singerCache.forEach(function (s) {
      var names = [s.name_zh, s.name_en].filter(Boolean);
      for (var i = 0; i < names.length; i++) {
        var k = nk(names[i]);
        if (k.length >= 2 && allTextNk.indexOf(k) !== -1) { hits.push(s.id); break; }
      }
    });
    var uniq = [];
    hits.forEach(function (id) { if (uniq.indexOf(id) === -1) uniq.push(id); });
    return uniq.length === 1 ? uniq[0] : '';
  }

  /** 标题命中 cityMap 键 → 城市(同标题内长名优先);无 → '' */
  function matchCity(titles) {
    var keys = Object.keys(cityMap || {});
    if (!keys.length || !titles.length) return '';
    keys.sort(function (a, b) { return nk(b).length - nk(a).length; });
    for (var i = 0; i < titles.length; i++) {
      var t = nk(titles[i]);
      if (!t) continue;
      for (var j = 0; j < keys.length; j++) {
        var kk = nk(keys[j]);
        if (kk.length >= 2 && t.indexOf(kk) !== -1) return keys[j];
      }
    }
    return '';
  }

  var TECH_PREFIX_RE = /^[【\[(（][^】\])）]*(?:4k|8k|1080p|720p|60fps|60帧|修复|重[置制]|高清|超清|蓝光|hdr|杜比|dolby|无损|ai|remaster|官方|mv|现场|live|纯享|中字|字幕|首发|合集|精选|珍藏)[^】\])）]*[】\])）]\s*/i;
  var TRAILING_TAG_RE = /\s*[-_—–\s]*[【\[(（]?(?:完整版|全场完整版|全场|纯享版|纯享|特效字幕|双语字幕|中文字幕|中字|精校字幕|无损音质|超清修复|蓝光原盘|蓝光重制|remastered?|(?:official\s*)?(?:music\s*video|mv|audio))[】\])）]?\s*$/i;

  /** 成对括号解包:利用深度计数,仅当开括号在首位且闭括号恰在末尾时剥除最外层(支持嵌套、多层) */
  function unwrapEnclosingBrackets(str) {
    var s = String(str || '').trim();
    var pairs = [
      { open: '【', close: '】' },
      { open: '[', close: ']' },
      { open: '「', close: '」' },
      { open: '（', close: '）' },
      { open: '(', close: ')' }
    ];
    var changed = true;
    while (changed) {
      changed = false;
      for (var p = 0; p < pairs.length; p++) {
        var op = pairs[p].open;
        var cl = pairs[p].close;
        if (s.indexOf(op) === 0) {
          var depth = 0;
          var matchIdx = -1;
          for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            if (ch === op) depth++;
            else if (ch === cl) {
              depth--;
              if (depth === 0) { matchIdx = i; break; }
            }
          }
          if (matchIdx === s.length - 1) {
            s = s.slice(1, -1).trim();
            changed = true;
            break;
          }
        }
      }
    }
    return s;
  }

  /** 提取首个成对平衡括号片段(支持全角/半角) */
  function extractBalancedBracket(str, openChar, closeChar) {
    var start = str.indexOf(openChar);
    if (start === -1) return null;
    var depth = 0;
    for (var i = start; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          return {
            start: start,
            end: i + 1,
            inner: str.slice(start + 1, i),
            full: str.slice(start, i + 1)
          };
        }
      }
    }
    return null;
  }

  /** 视频 title → 演出标题候选(整场/非整场通用,R8):去站名尾缀(兜底)、去整段外层装饰括、去前置压制/画质标签、去尾随格式修饰词、trim ≤50 */
  function cleanVideoTitle(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var i = s.indexOf('_哔哩哔哩');
    if (i !== -1) s = s.slice(0, i).trim();
    var j = s.indexOf('_bilibili');
    if (j !== -1) s = s.slice(0, j).trim();

    // 1) 剥除最外层整体包裹的成对括号
    s = unwrapEnclosingBrackets(s);

    // 2) 循环剥除前置画质/压制/技术标签(如【4K60FPS修复】、【超清4K】等)
    var prev = '';
    while (prev !== s) {
      prev = s;
      var next = s.replace(TECH_PREFIX_RE, '').trim();
      if (next) s = next;
      else break;
    }

    // 3) 循环剥除尾部格式修饰词(如 完整版、特效字幕、纯享版等)
    prev = '';
    while (prev !== s) {
      prev = s;
      var nextTail = s.replace(TRAILING_TAG_RE, '').trim();
      if (nextTail) s = nextTail;
      else break;
    }

    s = s.replace(/\s+/g, ' ').trim();
    return s.slice(0, 50);
  }

  /** R8 剥歌手前缀(2026-09-09):候选标题以当前歌手 zh/en 名任一开头 → 剥掉该名与尾随分隔符
   *  (空格/·/—/–/-/全角空格/(/（/[【/、/,/，/:/： 等)。支持连续中英文名剥除(如"陶喆 David Tao - ");
   *  标题不以歌手开头 / 歌手未定(id 空或不在 singerCache)→ 原样;剥后为空(标题整段就是歌手名)→ 也不剥。
   *  @returns {string} 剥后 title 或原样 title */
  function stripSingerPrefix(title, singerId) {
    var t = String(title == null ? '' : title).trim();
    if (!t || !singerId || !singerCache.length) return t;
    var s = null;
    for (var i = 0; i < singerCache.length; i++) {
      if (singerCache[i].id === singerId) { s = singerCache[i]; break; }
    }
    if (!s) return t;
    var variants = [s.name_zh, s.name_en].filter(Boolean);
    variants.sort(function (a, b) { return b.length - a.length; });
    var looping = true;
    while (looping) {
      looping = false;
      for (var j = 0; j < variants.length; j++) {
        var nm = String(variants[j]).trim();
        if (!nm || t.indexOf(nm) !== 0) continue;
        var rest = t.slice(nm.length)
          .replace(/^[\s　·•—–\-_/\\（(【[、,，.。:：;；!！?？」』]+/, '');
        if (rest) {
          t = rest;
          looping = true;
          break;
        }
      }
    }
    return t;
  }

  /** 强信号识曲:title 中命中 approved name/alias 的 nk 子串(长度≥2),按 tagId 去重返回 canonical 名 */
  function matchSongs(titles) {
    var out = [];
    var seen = {};
    if (!approvedSongs.length || !titles.length) return out;
    for (var i = 0; i < titles.length; i++) {
      var kTitle = nk(titles[i]);
      if (!kTitle) continue;
      for (var j = 0; j < approvedSongs.length; j++) {
        var t = approvedSongs[j];
        if (seen[t.id]) continue;
        var keys = [t.name].concat(t.aliases || []);
        for (var k = 0; k < keys.length; k++) {
          var kk = nk(keys[k]);
          if (kk.length >= 2 && kTitle.indexOf(kk) !== -1) { seen[t.id] = 1; out.push(t.name); break; }
        }
      }
    }
    return out;
  }

  /** bilibili URL → canonical `https://www.bilibili.com/video/<BV|av>`(去全部 query 跟踪参数)。
   *  BV 区分大小写、原样;av 归一为小写(与读路径 parseVideo 键派生一致)。解析不出视频段
   *  (b23 短链等)→ 至少去掉 query 跟踪参数,留给在线 redirect 解析。 */
  function canonicalBiliUrl(raw) {
    var s = String(raw || '').trim();
    var m = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(s);
    if (m) {
      var id = m[1];
      if (/^av/i.test(id)) id = id.toLowerCase();
      return 'https://www.bilibili.com/video/' + id;
    }
    var q = s.indexOf('?');
    return q === -1 ? s : s.slice(0, q);
  }

  /** R1 解析分享文字粘贴(2026-09-09):提交者复制的是 bilibili/YouTube 分享文字
   *  (典型 `【标题】 URL?share_source=…&vd_source=…`)。抽首个白名单视频 URL 作 canonical,
   *  并抽标题候选(供 bilibili 本地预填,零网络)。
   *  @returns {{url:string, title?:string}|null} —— 0 个白名单 URL → null(不误改输入框) */
  function extractSharePaste(text) {
    var s = String(text || '');
    // 1) URL:扫 http(s) token,取首个白名单 host(剥行尾自然语言标点/引号——分享文字常在
    //    URL 后直接跟中文标点、无空格;只剥 token 尾部,不伤 URL 本体)
    var toks = s.match(/https?:\/\/[^\s"'<>]+/g) || [];
    var found = '';
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i].replace(/[）)\]】』」>'"”…。.,，、;；!！?？]+$/, '');
      if (isAllowedVideoUrl(t)) { found = t; break; }
    }
    if (!found) return null;
    var canonical = videoProvider(found) === 'bilibili' ? canonicalBiliUrl(found) : found;
    // 2) 标题候选:剥离 URL 与平台样板词后,通过成对平衡括号解包外层,提取完整内层标题
    var noUrl = s.replace(/https?:\/\/[^\s"'<>]+/g, '').trim();
    noUrl = noUrl
      .replace(/[-_]\s*哔哩哔哩/g, '')
      .replace(/[-_]\s*bilibili/gi, '')
      .replace(/复制打开\s*[【\[]?哔哩哔哩[】\]]?/g, '')
      .replace(/b23\.tv[^\s]*/g, '')
      .trim();

    var title = '';
    // ① 若整段为成对括号【...】/[...]包裹(B站标准分享格式),利用深度计数剥除最外层,避免内层【4K修复】提前截断
    var unwrapped = unwrapEnclosingBrackets(noUrl);
    if (unwrapped && unwrapped !== noUrl) {
      title = unwrapped;
    } else {
      // ② 若整段内部包含成对全角【...】或半角 [...]
      var brk = extractBalancedBracket(noUrl, '【', '】') || extractBalancedBracket(noUrl, '[', ']');
      if (brk) {
        var after = noUrl.slice(brk.end).trim();
        // 若闭括号后仍有实质内容(如 "【4K】周杰伦演唱会"),则括号仅是前缀标签,取整段;否则取括号内
        title = after.length > 0 ? noUrl : brk.inner.trim();
      } else {
        // ③ 兜底:首行非链接文本
        var lines = noUrl.split(/\r?\n/).map(function (ln) { return ln.trim(); }).filter(Boolean);
        title = lines[0] || noUrl;
      }
    }
    title = cleanVideoTitle(title); // 剥 _哔哩哔哩/_bilibili 尾缀、压制/画质标签、格式词、压缩空白
    var out = { url: canonical };
    if (title) out.title = title;
    return out;
  }

  /** 把分享文字抽取结果写进链接行(paste 事件用):改写 URL + 存 pasteTitle。
   * 0 个白名单 URL → 不改输入框(返回 false,让默认粘贴继续)。
   * 程序赋值 .value 不触发 input 事件 → 手动镜像 input 监听副作用(bilibili 开关可用性)。 */
  function applySharePasteToRow(div, text) {
    var urlInput = div.querySelector('.link-url');
    var ex = extractSharePaste(text);
    if (!ex) return false;
    div._pasteCanonical = ex.url; // 先置标记:后续用户手改(≠canonical)→ input 监听清 pasteTitle
    urlInput.value = ex.url;
    var chk = div.querySelector('.link-whole-check');
    var ok = window.TrackTime.isBilibili(ex.url);
    chk.disabled = !ok;
    if (!ok && chk.checked) setWhole(div, false); // 改成非 bilibili → 收起整场(行内数据保留)
    div.dataset.pasteTitle = ex.title || '';
    return true;
  }

  /** R6 行内小封面:解析拿到 cover_url → 显示;onerror(外链不可达)→ 隐藏灰占位不破版 */
  function setRowCover(row, coverUrl) {
    var img = row ? row.querySelector('.link-row__thumb') : null;
    if (!img) return;
    if (!coverUrl) { img.hidden = true; img.removeAttribute('src'); return; }
    img.onerror = function () { img.hidden = true; };
    img.onload = function () { img.hidden = false; };
    img.src = coverUrl;
  }

  /** 从链接行收集合法 URL(非空 + http(s) + 白名单 host),附 pasteTitle(bilibili 本地标题) */
  function collectParseRows() {
    var out = [];
    var rows = q('link-rows').querySelectorAll('.link-row');
    for (var i = 0; i < rows.length; i++) {
      var url = rows[i].querySelector('.link-url').value.trim();
      if (!url || !isAllowedVideoUrl(url)) continue;
      var chk = rows[i].querySelector('.link-whole-check');
      out.push({ row: rows[i], url: url, whole: !!(chk && chk.checked), pasteTitle: rows[i].dataset.pasteTitle || '' });
    }
    return out;
  }

  function setParseBusy(busy) {
    parseBusy = busy;
    var btn = q('links-parse');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? '解析中…' : '解析视频并预填';
  }

  /** 顺序抓取每行 meta(失败 {ok:false}/429/网络错误 → 记 failedItems 继续,不中断后续行)。
   *  failed = 确实拿不到 title 的条数(在线失败)。 */
  function runParseQueue(queue) {
    var results = [];
    var failedItems = [];
    var p = Promise.resolve();
    queue.forEach(function (item) {
      p = p.then(function () {
        return fetch('/api/video-meta?url=' + encodeURIComponent(item.url)).then(function (r) {
          if (r.status === 429) { failedItems.push({ row: item.row, whole: item.whole, url: item.url, reason: '429' }); return null; }
          return r.json().then(function (d) {
            if (!d || d.ok !== true || !d.meta || !d.meta.title) { failedItems.push({ row: item.row, whole: item.whole, url: item.url, reason: 'no-title' }); return null; }
            return { row: item.row, whole: item.whole, provider: d.provider || '', meta: d.meta };
          });
        }).catch(function () { failedItems.push({ row: item.row, whole: item.whole, url: item.url, reason: 'network' }); return null; });
      }).then(function (r) {
        if (r) results.push(r);
      });
    });
    return p.then(function () {
      return { results: results, failedItems: failedItems, failed: failedItems.length };
    });
  }

  /** R4 形式枚举匹配:标题 nk 文本命中 TYPE_LABELS 任一枚举值(整词子串,「其他」不作关键词)。
   *  命中恰好 1 种 → 返回该枚举;0 / 多种(歧义)→ ''(留人)。 */
  function inferType(titles) {
    var textNk = nk((titles || []).join('\n'));
    if (!textNk) return '';
    var hits = [];
    TYPE_LABELS.forEach(function (label) {
      var k = nk(label);
      if (k && textNk.indexOf(k) !== -1) hits.push(label);
    });
    var uniq = [];
    hits.forEach(function (h) { if (uniq.indexOf(h) === -1) uniq.push(h); });
    return uniq.length === 1 ? uniq[0] : '';
  }

  /** 解析完成 → 只填空字段 + 形式枚举匹配 + 识曲预填 + 弹检查模态(许可门槛)。
   *  rows(源无关):每行 {row, whole, title, cover_url?} —— youtube 在线 / bilibili 本地粘贴标题 /
   *  bilibili 缓存命中统一同构;failed = 在线确无 title 的条数(解析失败)。 */
  function applyPrefill(rows, failed) {
    // R6 行内小封面:有 cover_url 的行显示(封面收录后由解析带出)
    rows.forEach(function (r) { if (r.cover_url) setRowCover(r.row, r.cover_url); });

    var withTitle = [];
    var wholeTitles = [];
    var nonWholeTitles = [];
    rows.forEach(function (r) {
      var t = r.title ? String(r.title).trim() : '';
      if (!t) return;
      withTitle.push({ row: r.row, whole: r.whole, title: t });
      if (r.whole) wholeTitles.push(t);
      else nonWholeTitles.push(t);
    });
    var allNk = nk(withTitle.map(function (x) { return x.title; }).join('\n'));
    var filled = [];

    // 1) 歌手:仅当未选且无歌曲输入且唯一命中才设;变歌手要等 loadCatalog 就绪再识曲
    var singerSel = q('f-singer');
    var curSinger = singerSel ? singerSel.value : '';
    var needCatalog = false;
    if (singerSel && (!curSinger || curSinger === '__request__') && !hasSongText() && allNk) {
      var want = inferSingerId(allNk);
      if (want) {
        singerSel.value = want;
        filled.push({ label: '歌手', value: singerNameById(want) });
        needCatalog = (loadedSinger !== want);
      }
    }
    // R4 形式枚举:标题命中唯一形式值 && 用户未手改过 type → 自动设(命中值即当前值则无操作)
    var typeEl = q('f-type');
    if (typeEl && !typeTouched) {
      var form = inferType(withTitle.map(function (x) { return x.title; }));
      if (form && form !== typeEl.value) {
        typeEl.value = form;
        filled.push({ label: '形式', value: form });
      }
    }
    var ready = needCatalog ? loadCatalog() : Promise.resolve();
    return ready.then(function () {
      // 2) 年份(空才填)
      var yearEl = q('f-year');
      if (yearEl && !String(yearEl.value || '').trim()) {
        var m = /(19|20)\d{2}/.exec(allNk);
        if (m) { yearEl.value = m[0]; filled.push({ label: '年份', value: m[0] }); }
      }
      // 3) 城市 + 坐标(空才填;命中 cityMap 才填)
      var cityEl = q('f-city');
      if (cityEl && !String(cityEl.value || '').trim()) {
        var c = matchCity(withTitle.map(function (x) { return x.title; }));
        if (c) {
          cityEl.value = c;
          filled.push({ label: '城市', value: c });
          if (cityMap[c]) {
            var latEl = q('f-lat'), lngEl = q('f-lng');
            if (latEl && !String(latEl.value || '').trim()) latEl.value = cityMap[c].lat;
            if (lngEl && !String(lngEl.value || '').trim()) lngEl.value = cityMap[c].lng;
          }
          cityFilledFrom = c;
        }
      }
      // 4) 标题(空才填,R8 大胆填 2026-09-09):拿到任一可用标题候选就填 —— 整场候选优先,
      //    否则用首个非整场候选(YouTube 在线单曲同规则);候选 cleanVideoTitle 后若歌手已定
      //    再剥开头歌手名。都无候选 → 保留 year+city 组合默认兜底。错误标题留「请检查」人工改。
      var titleEl = q('f-title');
      if (titleEl && !String(titleEl.value || '').trim()) {
        var singerNow = singerSel ? singerSel.value : '';
        var singerIdForStrip = (singerNow && singerNow !== '__request__') ? singerNow : '';
        var rawTitleCand = wholeTitles.length ? wholeTitles[0] : (nonWholeTitles.length ? nonWholeTitles[0] : '');
        var newTitle = '';
        if (rawTitleCand) {
          newTitle = cleanVideoTitle(rawTitleCand);
          newTitle = stripSingerPrefix(newTitle, singerIdForStrip);
        }
        if (!newTitle) {
          var yv = yearEl ? String(yearEl.value || '').trim() : '';
          var cv = cityEl ? String(cityEl.value || '').trim() : '';
          if (yv && cv) newTitle = (yv + ' ' + cv + ' 演唱会').slice(0, 50);
        }
        if (newTitle) { titleEl.value = newTitle; filled.push({ label: '标题', value: newTitle }); }
      }
      // 5) 识曲:歌手确定(已选或刚推断)才做;只对非整场链接 title
      var singerVal = singerSel ? singerSel.value : '';
      var songNames = [];
      if (singerVal && singerVal !== '__request__' && nonWholeTitles.length) {
        songNames = matchSongs(nonWholeTitles);
      }
      songNames.forEach(function (nm) { addSongIntoForm(nm); });

      var summary = filled.slice();
      if (songNames.length) summary.push({ label: '曲目', value: songNames.join('、') });
      var note = failed ? failed + ' 条链接解析失败，已跳过。' : '';
      if (!summary.length) {
        var msg = failed
          ? failed + ' 条链接解析失败，请手动填写。'
          : '未解析到有效内容，请手动填写。';
        showLinksMsg(msg, true);
        return;
      }
      showPrefillDialog(summary, note);
      syncSubmitSteps();
    });
  }

  /** 弹「已自动预填,请检查」模态(许可门槛):列出预填摘要;关掉后可改,不改按预填提交。
   *  R11:复用全站 .modal 体系(显示态 = .open;关闭由 /js/modal.js 的 #modal-close / Esc / 背板承担)。 */
  function showPrefillDialog(items, note) {
    var dlg = q('modal');
    var ul = q('prefill-summary');
    if (!dlg || !ul) return;
    ul.innerHTML = '';
    items.forEach(function (it) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      label.className = 'prefill-label';
      label.textContent = it.label + ':';
      var val = document.createElement('span');
      val.className = 'prefill-val';
      val.textContent = it.value;
      li.appendChild(label);
      li.appendChild(val);
      ul.appendChild(li);
    });
    if (note) {
      var liNote = document.createElement('li');
      liNote.className = 'prefill-note';
      liNote.textContent = note;
      ul.appendChild(liNote);
    }
    dlg.classList.add('open');
    var ok = q('prefill-ok');
    if (ok) ok.focus();
  }

  function closePrefillDialog() {
    var dlg = q('modal');
    if (dlg) dlg.classList.remove('open');
    var card2 = q('step-card-2');
    if (card2) card2.scrollIntoView({ behavior: 'smooth', block: 'start' });
    syncSubmitSteps();
  }

  /** 解析链接区全部视频链接并预填(入口;busy 防连点)。
   *  三桶(2026-09-09):youtube → 在线 /api/video-meta;bilibili 带本地粘贴标题 → 本地零网络;
   *  bilibili 裸链接 → /api/video-meta(后端先查 video_meta 缓存,命中零上游回 title;未收录才现抓)。 */
  function parseLinks() {
    if (parseBusy) return;
    var msgEl = q('links-msg');
    if (msgEl) msgEl.hidden = true;
    var all = collectParseRows();
    // 解析前清各行旧封面(本次拿不到的封面不残留)
    var linkRows = q('link-rows').querySelectorAll('.link-row');
    for (var ri = 0; ri < linkRows.length; ri++) setRowCover(linkRows[ri], '');
    if (!all.length) {
      showLinksMsg('请先填写视频链接', true);
      return;
    }
    var queue = [];
    var local = [];
    for (var i = 0; i < all.length; i++) {
      if (videoProvider(all[i].url) === 'youtube') queue.push(all[i]);
      else if (all[i].pasteTitle) local.push(all[i]);
      else queue.push(all[i]); // bilibili 裸链接 → 在线(查库兜底;未收录才现抓/412→{ok:false})
    }
    setParseBusy(true);
    runParseQueue(queue).then(function (o) {
      var rows = [];
      o.results.forEach(function (r) {
        var m = r.meta || {};
        rows.push({ row: r.row, whole: r.whole, title: m.title ? String(m.title).trim() : '', cover_url: m.cover_url || '' });
      });
      local.forEach(function (it) {
        rows.push({ row: it.row, whole: it.whole, title: it.pasteTitle, cover_url: '' });
      });
      return applyPrefill(rows, o.failed);
    }).then(function () {
      setParseBusy(false);
    }).catch(function () {
      setParseBusy(false);
      showLinksMsg('解析出错,请重试', true);
    });
  }

  /** 写入表单(canonical 预填 / 解析识曲后调用)。整场模式 → 逐曲行(空行优先填充,无则新增);
   *  否则追加顶部歌曲框(精确同名跳过,按现有顿号/换行分隔)。文本原样写入:
   *  canonical 名 → collect 精确命中 attached;新名 → collect 走 pending 提案。
   *  写库仍只在用户点提交时发生(预填先经「请检查」模态许可)。 */
  function addSongIntoForm(text) {
    var name = String(text || '').trim();
    if (!name) return;
    var row = engagedRow();
    if (row) {
      var editor = row.querySelector('.track-editor');
      var existing = editor ? editor.querySelectorAll('.track-row') : [];
      for (var i = 0; i < existing.length; i++) {
        var nameInput = existing[i].querySelector('.track-name');
        if (nameInput && nameInput.value.trim() === name) { nameInput.focus(); return; }
      }
      // setWhole 会自动开一个空壳行 → 优先填它,避免多出空行
      var allRows = editor ? editor.querySelectorAll('.track-row') : [];
      for (var j = 0; j < allRows.length; j++) {
        var ni = allRows[j].querySelector('.track-name');
        var ti = allRows[j].querySelector('.track-time');
        if (ni && !ni.value.trim() && ti && !ti.value.trim()) { ni.value = name; ni.focus(); return; }
      }
      if (editor) makeTrackRow(editor, name, '');
      return;
    }
    var el = q('f-songs');
    if (!el) return;
    if (songNameInBox(name)) { el.focus(); return; }
    var base = el.value.replace(/\s+$/, '');
    if (base && !/[、\n]$/.test(base)) base += '、';
    el.value = base + name;
    syncSongChips();
    el.focus();
  }

  function loadCatalog() {
    var sel = q('f-singer');
    var singerId = sel ? sel.value : '';
    var hasSinger = !!singerId && singerId !== '__request__';
    loadedSinger = singerId;
    // v6:歌曲归属歌手 —— 只拉当前所选歌手的已收录歌当建议,不选歌手不显示任何歌(防跨歌手串台)
    var url = hasSinger ? '/api/tags?singer=' + encodeURIComponent(singerId) : '/api/tags';
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      catalog = d || { categories: [] };
      // 歌曲目录:approved「歌曲」类别 → 建议数据 + 直连命中;缺失 → 提交走 category_name 提案
      songCatId = null; approvedSongs = [];
      var songCat = null;
      for (var ci = 0; ci < catalog.categories.length; ci++) {
        if (catalog.categories[ci].name === SONG_CATEGORY) { songCat = catalog.categories[ci]; break; }
      }
      if (songCat) {
        songCatId = songCat.id;
        if (hasSinger) {
          approvedSongs = (songCat.tags || []).slice().sort(function (a, b) {
            return (b.name || '').length - (a.name || '').length;
          });
        }
      }
      fillSongDatalist();
      renderPicker();
      renderSongChips();
      // 已展开的整场逐曲编辑器芯片也随(歌手)建议重建(编辑/建议修改回填场景)
      var editors = q('link-rows').querySelectorAll('.track-editor:not([hidden])');
      for (var ei = 0; ei < editors.length; ei++) renderTrackChips(editors[ei]);
      renderProposeCategories();
    }).catch(function () {});
  }

  function collect() {
    var wholeRow = engagedRow();

    // 逐曲表(仅整场勾选行;空名行跳过,时间可空;part=分 P,缺省 1)
    var tracks = [];
    if (wholeRow) {
      // 容错:若用户在粘贴框贴了文本但漏点了「解析并填入」按钮(且当前逐曲表无有效内容)，自动先解析填入
      var pasteText = wholeRow.querySelector('.list-paste-text');
      var trackRows = wholeRow.querySelectorAll('.track-row');
      if (pasteText && pasteText.value.trim() && window.TrackTime && window.TrackTime.parseList) {
        var hasContent = false;
        for (var pi = 0; pi < trackRows.length; pi++) {
          if (trackRows[pi].querySelector('.track-name').value.trim() || trackRows[pi].querySelector('.track-time').value.trim()) {
            hasContent = true;
            break;
          }
        }
        if (!hasContent) {
          var res = window.TrackTime.parseList(pasteText.value);
          if (res.rows.length) {
            wholeRow.querySelector('.track-rows').innerHTML = '';
            res.rows.forEach(function (r) {
              makeTrackRow(wholeRow.querySelector('.track-editor'), r.name, window.TrackTime.format(r.seconds), r.part);
            });
            pasteText.value = '';
            var pasteBody = wholeRow.querySelector('.list-paste__body');
            if (pasteBody) pasteBody.hidden = true;
          }
        }
      }

      readTrackRows(wholeRow.querySelector('.track-editor')).forEach(function (it) {
        if (!it.name) return;
        tracks.push({ name: it.name, seconds: it.timeStr ? it.parsed.sec : null, part: it.part });
      });
    }

    var links = [];
    Array.prototype.forEach.call(q('link-rows').querySelectorAll('.link-row'), function (row) {
      var label = row.querySelector('.link-label').value.trim();
      var url = row.querySelector('.link-url').value.trim();
      if (label || url) {
        // is_full 仅当:本行是整场勾选行 且 逐曲表有有效行(否则不落空壳;后端 tracks 空也会清)
        links.push({ label: label || '链接', url: url, is_full: row === wholeRow && tracks.length > 0 });
      }
    });

    var proposedTags = [];
    var namesStr = q('propose-tags').value;
    var catId = q('propose-category').value;
    var newCat = q('propose-new-category').value.trim();
    if (namesStr.trim()) {
      namesStr.split(/[,，\n]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 10).forEach(function (name) {
        if (newCat) proposedTags.push({ name: name, category_name: newCat });
        else if (catId) proposedTags.push({ name: name, category_id: catId });
      });
    }

    // 歌曲来源(二选一,2026-09-07):整场逐曲表启用 → 从逐曲表行歌名镜像(顶部歌曲框让位);
    // 否则照旧从顶部歌曲框。同名多行(encore 等)只镜像一次标签,逐曲表行仍都保留。
    // 组曲拆解(2026-10-21):若逐曲表中为连唱组曲(如 A＋B＋C),逐曲表保持单行时间轴打点,
    // 但曲库标签镜像自动拆解为 A、B、C 独立单曲,分别打标/提议新歌。
    var tags = Object.keys(selectedTagIds);
    var songNames = [];
    if (wholeRow) {
      readTrackRows(wholeRow.querySelector('.track-editor')).forEach(function (it) {
        if (it.name) {
          var subs = (window.TrackTime && window.TrackTime.splitMedleySongs)
            ? window.TrackTime.splitMedleySongs(it.name)
            : [it.name];
          subs.forEach(function (sn) { songNames.push(sn); });
        }
      });
    } else {
      var songStr = q('f-songs') ? q('f-songs').value : '';
      if (songStr.trim()) {
        var rawList = (window.TrackTime && window.TrackTime.splitSongList)
          ? window.TrackTime.splitSongList(songStr)
          : songStr.split(/[、\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
        rawList.forEach(function (s) {
          var subs = (window.TrackTime && window.TrackTime.splitMedleySongs)
            ? window.TrackTime.splitMedleySongs(s)
            : [s];
          subs.forEach(function (sn) {
            songNames.push(matchKnownSong(sn) || sn);
          });
        });
      }
    }
    if (songNames.length) {
      var songTagSet = {};
      tags.forEach(function (id) { songTagSet[id] = 1; });
      var seen = {};
      songNames.forEach(function (name) {
        if (seen[name]) return;
        seen[name] = 1;
        var hit = null;
        for (var i = 0; i < approvedSongs.length; i++) {
          if (approvedSongs[i].name === name) { hit = approvedSongs[i]; break; }
        }
        if (hit) songTagSet[hit.id] = 1;
        else if (songCatId) proposedTags.push({ name: name, category_id: songCatId });
        else proposedTags.push({ name: name, category_name: SONG_CATEGORY });
      });
      tags = Object.keys(songTagSet);
    }

    var singerVal = q('f-singer').value;
    return {
      singer: singerVal === '__request__' ? '' : singerVal,
      title: q('f-title').value.trim(),
      year: Number(q('f-year').value),
      date: q('f-date').value.trim(),
      type: q('f-type').value,
      venue: q('f-venue').value.trim(),
      city: q('f-city').value.trim(),
      lat: Number(q('f-lat').value),
      lng: Number(q('f-lng').value),
      note: q('f-note').value.trim(),
      links: links,
      tracks: tracks,
      tags: tags,
      proposed_tags: proposedTags
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    Auth.renderAuthLink(q('auth-link'));

    // 城市坐标:库内精确命中「输入即填」;不在库 → 失焦时服务器端 geocode 兜底
    loadCities();

    var cityEl = q('f-city');
    if (cityEl) {
      cityEl.addEventListener('input', function () {
        var c = this.value.trim();
        var geoMsg = q('geo-msg');
        if (cityMap[c]) {
          q('f-lat').value = cityMap[c].lat;
          q('f-lng').value = cityMap[c].lng;
          cityFilledFrom = c;
          if (geoMsg) geoMsg.hidden = true;
        } else if (!coordsTouched && c !== cityFilledFrom) {
          // 改城市 → 旧坐标已失效(非库内、非手改时清空,等 blur 去解析新城市)
          q('f-lat').value = '';
          q('f-lng').value = '';
          cityFilledFrom = '';
          if (geoMsg) geoMsg.hidden = true;
        }
      });

      cityEl.addEventListener('blur', function () {
        var c = this.value.trim();
        var geoMsg = q('geo-msg');
        if (!c || cityMap[c] || coordsTouched) return;
        if (q('f-lat').value !== '' || q('f-lng').value !== '') return;
        geoInFlight = c;
        fetch('/api/geocode?q=' + encodeURIComponent(c))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            // 防串:仅当未手改、仍是本次 q、城市未被再改时才应用迟到结果
            if (coordsTouched || geoInFlight !== c || q('f-city').value.trim() !== c) return;
            var results = (d && d.results) || [];
            if (results[0]) {
              q('f-lat').value = results[0].lat;
              q('f-lng').value = results[0].lng;
              cityFilledFrom = c;
              if (geoMsg) {
                geoMsg.textContent = '已解析坐标: ' + (results[0].label || '');
                geoMsg.hidden = false;
              }
            } else if (geoMsg) {
              geoMsg.textContent = '城市未识别，请手填经纬度';
              geoMsg.hidden = false;
            }
          })
          .catch(function () {
            if (geoMsg && !coordsTouched && geoInFlight === c && q('f-city').value.trim() === c) {
              geoMsg.textContent = '城市未识别，请手填经纬度';
              geoMsg.hidden = false;
            }
          })
          .finally(function () {
            if (geoInFlight === c) geoInFlight = '';
          });
      });
    }

    // 手动编辑坐标 → 接管,blur 不再自动覆盖
    var latEl = q('f-lat');
    var lngEl = q('f-lng');
    if (latEl) latEl.addEventListener('input', markCoordsManual);
    if (lngEl) lngEl.addEventListener('input', markCoordsManual);

    // R4 形式:用户手选过任何形式 → 预填不再自动改 type
    var fType = q('f-type');
    if (fType) fType.addEventListener('change', function () { typeTouched = true; });

    var params = new URLSearchParams(location.search);
    var editId = params.get('edit');
    var draftId = params.get('draft');
    var preselectSinger = params.get('singer') || '';
    var mode = 'new';

    Auth.requireSession(q('auth-gate'), function () {
      q('auth-gate').hidden = true;
      q('submit-form').hidden = false;

      // 步骤指示胶囊交互
      var stepBtns = document.querySelectorAll('.submit-step');
      for (var sbi = 0; sbi < stepBtns.length; sbi++) {
        (function (b) {
          b.addEventListener('click', function () {
            var s = b.getAttribute('data-step');
            var card = q('step-card-' + s);
            if (card) {
              card.scrollIntoView({ behavior: 'smooth', block: 'start' });
              var firstInput = card.querySelector('input:not([hidden]), select, textarea');
              if (firstInput) firstInput.focus({ preventScroll: true });
            }
          });
        })(stepBtns[sbi]);
      }

      var formEl = q('submit-form');
      if (formEl) {
        formEl.addEventListener('focusin', function (e) {
          var card = e.target.closest('.step-card');
          if (!card) return;
          var step = card.getAttribute('data-step');
          var allSteps = document.querySelectorAll('.submit-step');
          for (var si = 0; si < allSteps.length; si++) {
            allSteps[si].classList.toggle('active', allSteps[si].getAttribute('data-step') === step);
          }
        });
        formEl.addEventListener('input', syncSubmitSteps);
        formEl.addEventListener('change', syncSubmitSteps);
      }

      q('add-link').addEventListener('click', function () { addLinkRow(); });
      // 仅新建模式默认给一行空链接;edit/draft 模式由 loadRow 回填已有链接(否则空行浮在已填链接上面)
      if (!editId && !draftId) addLinkRow();
      var songsInput = q('f-songs');
      if (songsInput) songsInput.addEventListener('input', syncSongChips);

      // 链接区「解析视频并预填」→ 批量解析自动预填 + 弹检查模态
      var linksParse = q('links-parse');
      if (linksParse) linksParse.addEventListener('click', parseLinks);
      // 预填检查模态:点遮罩 / 知道了 / Esc 关闭(R11 后主逻辑在 modal.js;此处为无 modal.js 时的兜底,幂等)
      var prefillDlg = q('modal');
      var prefillOk = q('prefill-ok');
      if (prefillOk) prefillOk.addEventListener('click', closePrefillDialog);
      if (prefillDlg) {
        prefillDlg.addEventListener('click', function (e) {
          if ((e.target === prefillDlg || e.target.classList.contains('modal-backdrop')) &&
              prefillDlg.classList.contains('open')) closePrefillDialog();
        });
      }
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          var dlg = q('modal');
          if (dlg && dlg.classList.contains('open')) { closePrefillDialog(); e.preventDefault(); }
        }
      });

      q('f-singer').addEventListener('change', function () {
        this._userChanged = true;
        var v = this.value;
        if (v === '__request__') {
          this.value = loadedSinger;
          if (window.SingerRequest) SingerRequest.open();
          return;
        }
        if (v === loadedSinger) return;
        // v6:换歌手 = 换建议目录;已填歌/逐曲表属上一歌手,先确认后清空再拉新建议
        var sel = this;
        if (hasSongInput()) {
          var proceedChangeSinger = function () {
            clearSongInput();
            loadCatalog();
          };
          if (window.AppDialog) {
            AppDialog.confirm({
              title: '切换歌手确认',
              message: '切换歌手会清空当前已填写的歌曲与逐曲列表，确认切换吗？',
              confirmText: '确认切换',
              danger: true
            }).then(function (ok) {
              if (ok) {
                proceedChangeSinger();
              } else {
                sel.value = loadedSinger;
              }
            });
            return;
          } else {
            if (!window.confirm('切换歌手会清空已填的歌曲与整场逐曲表,继续吗?')) { sel.value = loadedSinger; return; }
            proceedChangeSinger();
            return;
          }
        }
        loadCatalog();
      });

      loadSingers(preselectSinger).then(function () { return loadCatalog(); }).then(function () {
        if (editId) {
          mode = 'edit';
          q('submit-title').textContent = '编辑待审核提交';
          q('submit-hint').textContent = '修改后保存,仍在原条目上更新。';
          q('save-btn').textContent = '保存修改';
          fetch('/api/my-submissions').then(function (r) { return r.json(); }).then(function (list) {
            var t = list.filter(function (x) { return x.id === editId; })[0];
            if (t) loadRow(t);
          });
        } else if (draftId) {
          mode = 'draft';
          q('submit-title').textContent = '建议修改 · 已审核条目';
          q('submit-hint').textContent = '你的修改将以草稿提交,管理员审核通过后替换原条目。';
          q('save-btn').textContent = '提交修改建议';
          fetch('/api/performances').then(function (r) { return r.json(); }).then(function (list) {
            var t = list.filter(function (x) { return x.id === draftId; })[0];
            if (t) loadRow(t);
          });
        }
        syncSubmitSteps();
      });
    });

    q('submit-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = q('form-err');
      var tErr = validateTracks();
      if (tErr) { err.textContent = tErr; err.hidden = false; return; }
      var data = collect();
      if (!data.singer) { err.textContent = '请选择歌手'; err.hidden = false; return; }
      if (!data.type) { err.textContent = '请选择形式'; err.hidden = false; return; }
      if (!data.title || !data.city || !data.year) { err.textContent = '标题 / 年份 / 城市必填'; err.hidden = false; return; }
      if (!data.lat || !data.lng) { err.textContent = '请补齐经纬度坐标'; err.hidden = false; return; }
      if (data.title.length > 50) { err.textContent = '标题过长(≤50 字)'; err.hidden = false; return; }
      if (data.note.length > 500) { err.textContent = '备注过长(≤500 字)'; err.hidden = false; return; }
      if (data.links.length > 10) { err.textContent = '链接最多 10 条'; err.hidden = false; return; }
      for (var i = 0; i < data.links.length; i++) {
        if (data.links[i].label.length > 100) { err.textContent = '链接名过长(≤100 字)'; err.hidden = false; return; }
        if (data.links[i].url.length > 200) { err.textContent = '链接过长(≤200 字)'; err.hidden = false; return; }
      }
      var target = mode === 'edit' ? editId : (mode === 'draft' ? draftId : null);
      var url = target ? '/api/submissions/' + encodeURIComponent(target) : '/api/submissions';
      var method = target ? 'PATCH' : 'POST';
      var btn = q('save-btn');
      btn.disabled = true;
      Auth.request(method, url, data).then(function (r) {
        btn.disabled = false;
        if (r.ok) {
          try { localStorage.setItem('last_submitted_singer', data.singer); } catch (e) {}
          // 提交即时反馈:本轮歌曲去向在「我的提交」页顶部横幅显示(song_report 为后端权威)
          var rep = r.data.song_report;
          if (rep && ((rep.attached && rep.attached.length) || (rep.pending && rep.pending.length) || (rep.duplicate && rep.duplicate.length))) {
            try { sessionStorage.setItem('singer_song_report', JSON.stringify({ attached: rep.attached, pending: rep.pending, duplicate: rep.duplicate })); } catch (e) {}
          }
          location.href = '/my-submissions';
        }
        else { err.textContent = r.data.error || '提交失败'; err.hidden = false; }
      });
    });
  });
})();
