/* my-submissions.js —— 我的提交:进行中(列表 + 状态 + 歌曲区 + 编辑/修改/删除)
 * 与 回收站(软删条目:恢复 / 彻底删除)。
 * 仿照 GeoGuide my-submissions:
 *   1. 审核状态细分子分段 (All / Pending / Approved / Rejected)
 *   2. 年份正序 / 倒序切换 (.sort-toggle)
 *   3. 歌手下拉分类筛选 (.filter-dropdown)
 *   4. 简易内联展开搜索框 (.search-chip)
 *   5. 实时数量统计与筛选重置
 */

(function () {
  'use strict';

  var STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
  var box = document.getElementById('mine-list');
  var controls = document.getElementById('mine-controls');
  var views = document.getElementById('mine-views');
  var statusRow = document.getElementById('mine-status-row');
  var sortToggle = document.getElementById('sort-toggle');
  var singerFilterBtn = document.getElementById('singer-filter-btn');
  var singerFilterMenu = document.getElementById('singer-filter-menu');
  var singerFilterLabel = document.getElementById('singer-filter-label');
  var searchInput = document.getElementById('search-input');
  var searchClear = document.getElementById('search-clear');
  var mineCount = document.getElementById('mine-count');

  // State
  var view = 'list';           // 'list' | 'trash'
  var currentStatus = 'all';   // 'all' | 'pending' | 'approved' | 'rejected'
  var currentSort = 'newest';  // 'newest' | 'oldest'
  var currentSinger = null;    // null | singer_id
  var searchQuery = '';        // lowercase trimmed search string
  var rawSubmissions = [];     // unfiltered list from API
  var singerMap = {};          // singerId -> name_zh
  var singersLoaded = false;

  /** 提交页写入的歌曲去向报告 → 顶部横幅文案 */
  function songBannerText(rep) {
    var parts = [];
    if (rep.attached && rep.attached.length) parts.push('已收录 ' + rep.attached.length + ' 首');
    if (rep.pending && rep.pending.length) parts.push('新歌 ' + rep.pending.length + ' 首待收录');
    if (rep.duplicate && rep.duplicate.length) parts.push('同名歌 ' + rep.duplicate.length + ' 首待审核(未重复)');
    return parts.length ? '♫ 歌曲:' + parts.join(' / ') : '';
  }

  function showSongFlash() {
    var rep = null;
    try { rep = JSON.parse(sessionStorage.getItem('singer_song_report') || 'null'); } catch (e) { rep = null; }
    if (!rep) return;
    try { sessionStorage.removeItem('singer_song_report'); } catch (e) {}
    var text = songBannerText(rep);
    if (!text || !box) return;
    var flash = document.createElement('p');
    flash.className = 'list-card__songs-flash';
    flash.textContent = text;
    box.insertAdjacentElement('beforebegin', flash);
  }

  /** 歌曲区:已收录(approved)+ 待收录(pending 提案);两者皆空 → 「未填写歌曲」 */
  function songsSection(p) {
    var approved = p.songs || [];
    var pending = p.proposed_songs || [];
    var total = approved.length + pending.length;
    if (!total) {
      return '<div class="list-card__songs none">♫ 未填写歌曲</div>';
    }
    var spans = approved.map(function (n) {
      return '<span class="song-tag">' + Auth.esc(n) + '</span>';
    }).concat(pending.map(function (n) {
      return '<span class="song-tag song-tag--pending">' + Auth.esc(n) + ' · 待收录</span>';
    }));
    if (total > 6) {
      return '<details class="list-card__songs-fold"><summary>♫ 曲目 · ' + total + ' 首</summary>' +
        '<div class="list-card__songs list-card__songs--scroll">' + spans.join(' ') + '</div></details>';
    }
    return '<div class="list-card__songs">♫ ' + spans.join(' ') + '</div>';
  }

  function cornerHtml(p, isTrash) {
    var st = isTrash ? 'trash' : (p.status || 'pending');
    var label = isTrash ? '回收站' : (STATUS[p.status] || p.status);
    if (p.is_draft) label += ' · 草稿';
    return '<div class="card-corner card-corner--' + Auth.esc(st) + '" role="img" title="' + Auth.esc(label) + '" aria-label="' + Auth.esc(label) + '"></div>';
  }

  function metaLine(p) {
    var singer = singerMap[p.singer]
      ? '<span class="mine-card__singer">' + Auth.esc(singerMap[p.singer]) + '</span> · '
      : '';
    var geo = Auth.esc(p.city) + (p.venue ? ' · ' + Auth.esc(p.venue) : '');
    var typeBadge = p.type ? ' <span class="badge-type" data-type="' + Auth.esc(p.type) + '">' + Auth.esc(p.type) + '</span>' : '';
    return singer + geo + typeBadge;
  }

  function deleteConfirmText(p) {
    var head = p.status === 'approved' ? '这条演出已审核上线,删除后将下架,' : '删除后将进入回收站,';
    return head + '7 天内可恢复,逾期自动彻底清除。确定删除「' + p.title + '」?';
  }

  function linkHtml(p) {
    return (p.links || []).map(function (l) {
      return '<a class="mini-link" href="' + Auth.esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + Auth.esc(l.label) + '</a>';
    }).join('');
  }

  /* ---------- 进行中卡片 ---------- */
  function renderActiveCard(p) {
    var card = document.createElement('div');
    card.className = 'list-card list-card--corner';
    var editHref = p.status === 'approved'
      ? '/submit?draft=' + encodeURIComponent(p.id)
      : '/submit?edit=' + encodeURIComponent(p.id);
    var editLabel = p.status === 'approved' ? '修改' : '编辑';
    card.innerHTML =
      cornerHtml(p, false) +
      '<div class="list-card__title-row">' +
        '<div class="list-card__title" title="' + Auth.esc(p.title) + '">' +
          Auth.esc(p.title) +
          (p.is_draft ? ' <span class="list-card__meta-tag">修改版</span>' : '') +
        '</div>' +
        '<span class="list-card__year">' + Auth.esc(p.year) + '</span>' +
      '</div>' +
      '<div class="list-card__meta">' + metaLine(p) + '</div>' +
      songsSection(p) +
      (p.reject_reason ? '<div class="list-card__reject">驳回原因:' + Auth.esc(p.reject_reason) + '</div>' : '') +
      (linkHtml(p) ? '<div class="list-card__links">' + linkHtml(p) + '</div>' : '') +
      '<div class="list-card__actions">' +
        (p.status === 'approved' || p.edit_target_id ? (
          '<button type="button" class="ghost-icon-btn" data-act="share" title="复制演出链接" aria-label="复制演出链接">' +
            (window.Icons ? Icons.get('share') : '分享') +
          '</button> '
        ) : (
          '<button type="button" class="ghost-icon-btn" data-act="share-pending" title="审核通过后可公开分享" aria-label="审核通过后可公开分享" style="opacity:0.4;">' +
            (window.Icons ? Icons.get('share') : '分享') +
          '</button> '
        )) +
        '<a class="ghost-icon-btn" href="' + Auth.esc(editHref) + '" title="' + Auth.esc(editLabel) + '" aria-label="' + Auth.esc(editLabel) + '">' +
          (window.Icons ? Icons.get('edit') : Auth.esc(editLabel)) +
        '</a> ' +
        '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger" data-act="del" title="删除(进入回收站)" aria-label="删除">' +
          (window.Icons ? Icons.get('delete') : '删除') +
        '</button>' +
      '</div>';
    box.appendChild(card);

    var shareBtn = card.querySelector('[data-act="share"]');
    if (shareBtn) {
      shareBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var shareItem = { id: p.edit_target_id || p.id, singer: p.singer };
        var url = window.ShareUtils ? window.ShareUtils.buildPerformanceShareUrl(shareItem) : '';
        if (window.ShareUtils) {
          window.ShareUtils.copyWithFeedback(shareBtn, url, '演出链接已复制');
        }
      });
    }
    var sharePendingBtn = card.querySelector('[data-act="share-pending"]');
    if (sharePendingBtn) {
      sharePendingBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (window.AppDialog && AppDialog.toast) {
          AppDialog.toast('该演出正在审核中，通过后即可公开分享', { type: 'info' });
        }
      });
    }

    card.querySelector('[data-act="del"]').addEventListener('click', function () {
      var txt = deleteConfirmText(p);
      var doDel = function () {
        Auth.request('DELETE', '/api/submissions/' + encodeURIComponent(p.id)).then(function (r) {
          if (r.ok) {
            if (window.AppDialog) AppDialog.toast('已移入回收站 (保留7天)', { type: 'info' });
            load();
          } else {
            if (window.AppDialog) AppDialog.alert(r.data.error || '删除失败', { title: '操作失败' });
            else alert(r.data.error || '删除失败');
          }
        });
      };
      if (window.AppDialog) {
        AppDialog.confirm({
          title: '移入回收站',
          message: txt,
          confirmText: '移入回收站',
          danger: true
        }).then(function (ok) {
          if (ok) doDel();
        });
      } else {
        if (confirm(txt)) doDel();
      }
    });
  }

  /** 本地化 'YYYY-MM-DD HH:MM:SS'(UTC) → 'YYYY-MM-DD HH:mm'(本地) */
  function fmtDeleted(t) {
    if (!t) return '';
    var d = new Date(String(t).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return String(t).slice(0, 16);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------- 回收站卡片 ---------- */
  function renderTrashCard(p) {
    var card = document.createElement('div');
    card.className = 'list-card list-card--corner';
    card.innerHTML =
      cornerHtml(p, true) +
      '<div class="list-card__title-row">' +
        '<div class="list-card__title" title="' + Auth.esc(p.title) + '">' + Auth.esc(p.title) + '</div>' +
        '<span class="list-card__year">' + Auth.esc(p.year) + '</span>' +
      '</div>' +
      '<div class="list-card__meta">' + metaLine(p) + '</div>' +
      '<div class="list-card__del">删除于 ' + Auth.esc(fmtDeleted(p.deleted_at)) + '</div>' +
      '<div class="list-card__actions">' +
        '<button type="button" class="ghost-icon-btn" data-act="restore" title="恢复" aria-label="恢复">' +
          (window.Icons ? Icons.get('restore') : '恢复') +
        '</button> ' +
        '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger" data-act="purge" title="彻底删除" aria-label="彻底删除">' +
          (window.Icons ? Icons.get('delete') : '彻底删除') +
        '</button>' +
      '</div>';
    box.appendChild(card);

    card.querySelector('[data-act="restore"]').addEventListener('click', function () {
      var doRestore = function () {
        Auth.request('POST', '/api/submissions/' + encodeURIComponent(p.id) + '/restore', {}).then(function (r) {
          if (r.ok) {
            if (window.AppDialog) AppDialog.toast('已成功恢复提交', { type: 'success' });
            load();
          } else {
            if (window.AppDialog) AppDialog.alert(r.data.error || '恢复失败', { title: '操作失败' });
            else alert(r.data.error || '恢复失败');
          }
        });
      };
      if (window.AppDialog) {
        AppDialog.confirm({
          title: '恢复提交',
          message: '确定恢复这条提交「' + p.title + '」吗？',
          confirmText: '恢复'
        }).then(function (ok) { if (ok) doRestore(); });
      } else {
        if (confirm('恢复这条提交「' + p.title + '」?')) doRestore();
      }
    });
    card.querySelector('[data-act="purge"]').addEventListener('click', function () {
      var doPurge = function () {
        Auth.request('POST', '/api/submissions/' + encodeURIComponent(p.id) + '/purge', {}).then(function (r) {
          if (r.ok) {
            if (window.AppDialog) AppDialog.toast('已彻底删除', { type: 'info' });
            load();
          } else {
            if (window.AppDialog) AppDialog.alert(r.data.error || '删除失败', { title: '操作失败' });
            else alert(r.data.error || '删除失败');
          }
        });
      };
      if (window.AppDialog) {
        AppDialog.confirm({
          title: '彻底删除提交',
          message: '彻底删除「' + p.title + '」？此操作不可恢复，将连同其关联的新歌提案一并清除。',
          confirmText: '彻底删除',
          danger: true
        }).then(function (ok) { if (ok) doPurge(); });
      } else {
        if (confirm('彻底删除「' + p.title + '」?此操作不可恢复,将连同其关联的新歌提案一并清除。')) doPurge();
      }
    });
  }

  function applyFilters(rows) {
    return rows.filter(function (p) {
      // 1. 审核状态筛选 (仅在进行中视图下生效)
      if (view === 'list' && currentStatus !== 'all') {
        if (p.status !== currentStatus) return false;
      }
      // 2. 歌手筛选
      if (currentSinger) {
        if (p.singer !== currentSinger) return false;
      }
      // 3. 搜索词筛选 (标题、城市、场馆、年份、日期、类型、备注、歌手名、曲目)
      if (searchQuery) {
        var q = searchQuery.toLowerCase();
        var matchTitle = (p.title || '').toLowerCase().indexOf(q) !== -1;
        var matchCity = (p.city || '').toLowerCase().indexOf(q) !== -1;
        var matchVenue = (p.venue || '').toLowerCase().indexOf(q) !== -1;
        var matchYear = String(p.year || '').indexOf(q) !== -1;
        var matchDate = (p.date || '').indexOf(q) !== -1;
        var matchType = (p.type || '').toLowerCase().indexOf(q) !== -1;
        var matchNote = (p.note || '').toLowerCase().indexOf(q) !== -1;
        var sName = singerMap[p.singer] || p.singer || '';
        var matchSinger = sName.toLowerCase().indexOf(q) !== -1;
        var matchSongs = false;
        var allSongs = (p.songs || []).concat(p.proposed_songs || []);
        for (var i = 0; i < allSongs.length; i++) {
          if (allSongs[i].toLowerCase().indexOf(q) !== -1) { matchSongs = true; break; }
        }
        if (!matchTitle && !matchCity && !matchVenue && !matchYear && !matchDate && !matchType && !matchNote && !matchSinger && !matchSongs) {
          return false;
        }
      }
      return true;
    });
  }

  function applySort(rows) {
    return rows.slice().sort(function (a, b) {
      var yA = Number(a.year) || 0;
      var yB = Number(b.year) || 0;
      if (yA !== yB) {
        return currentSort === 'newest' ? (yB - yA) : (yA - yB);
      }
      var dA = a.date || '';
      var dB = b.date || '';
      if (dA && dB) {
        return currentSort === 'newest' ? dB.localeCompare(dA) : dA.localeCompare(dB);
      }
      return currentSort === 'newest' ? (dB ? 1 : -1) : (dA ? -1 : 1);
    });
  }

  function updateControls() {
    // 1. 状态细分分段与徽标统计 (仅在进行中展示)
    if (view === 'list') {
      statusRow.hidden = false;
      var counts = { all: rawSubmissions.length, pending: 0, approved: 0, rejected: 0 };
      rawSubmissions.forEach(function (p) {
        if (counts[p.status] !== undefined) counts[p.status]++;
      });
      var bAll = document.getElementById('badge-status-all');
      var bPending = document.getElementById('badge-status-pending');
      var bApproved = document.getElementById('badge-status-approved');
      var bRejected = document.getElementById('badge-status-rejected');
      if (bAll) bAll.textContent = counts.all;
      if (bPending) bPending.textContent = counts.pending;
      if (bApproved) bApproved.textContent = counts.approved;
      if (bRejected) bRejected.textContent = counts.rejected;
    } else {
      statusRow.hidden = true;
    }

    // 2. 歌手下拉菜单与数量
    var singerCounts = {};
    rawSubmissions.forEach(function (p) {
      if (p.singer) singerCounts[p.singer] = (singerCounts[p.singer] || 0) + 1;
    });
    var singerIds = Object.keys(singerCounts);
    if (currentSinger && !singerCounts[currentSinger]) {
      currentSinger = null;
    }
    singerFilterLabel.textContent = currentSinger ? (singerMap[currentSinger] || currentSinger) : '全部歌手';

    singerFilterMenu.innerHTML = '';
    // 全部歌手项
    var allItem = document.createElement('div');
    allItem.className = 'filter-dropdown__item' + (!currentSinger ? ' is-selected' : '');
    allItem.innerHTML = '<span>全部歌手</span><span class="filter-dropdown__count">' + rawSubmissions.length + '</span>';
    allItem.addEventListener('click', function () {
      currentSinger = null;
      singerFilterLabel.textContent = '全部歌手';
      singerFilterMenu.hidden = true;
      singerFilterBtn.setAttribute('aria-expanded', 'false');
      updateControls();
      render();
    });
    singerFilterMenu.appendChild(allItem);

    singerIds.sort(function (a, b) {
      var nA = singerMap[a] || a;
      var nB = singerMap[b] || b;
      return nA.localeCompare(nB, 'zh');
    });

    singerIds.forEach(function (sId) {
      var item = document.createElement('div');
      item.className = 'filter-dropdown__item' + (currentSinger === sId ? ' is-selected' : '');
      var sName = singerMap[sId] || sId;
      item.innerHTML = '<span>' + Auth.esc(sName) + '</span><span class="filter-dropdown__count">' + singerCounts[sId] + '</span>';
      item.addEventListener('click', function () {
        currentSinger = sId;
        singerFilterLabel.textContent = sName;
        singerFilterMenu.hidden = true;
        singerFilterBtn.setAttribute('aria-expanded', 'false');
        updateControls();
        render();
      });
      singerFilterMenu.appendChild(item);
    });

    // 3. 排序按钮文案与箭头
    var sortLabel = document.getElementById('sort-label');
    var sortArrow = document.getElementById('sort-arrow');
    if (sortLabel) sortLabel.textContent = currentSort === 'newest' ? '年份倒序' : '年份正序';
    if (sortArrow) sortArrow.textContent = currentSort === 'newest' ? '▾' : '▴';
  }

  function render() {
    box.hidden = false;
    box.innerHTML = '';

    if (!rawSubmissions.length) {
      mineCount.textContent = '共 0 条';
      var msg = view === 'trash'
        ? '<p class="empty">回收站为空。</p>'
        : '<p class="empty">还没有提交。去<a href="/submit">提交第一场演出</a>吧。</p>';
      box.innerHTML = msg;
      return;
    }

    var filtered = applyFilters(rawSubmissions);
    var sorted = applySort(filtered);

    // 更新数量统计
    var isFiltered = (currentStatus !== 'all' && view === 'list') || currentSinger !== null || searchQuery !== '';
    if (isFiltered) {
      mineCount.textContent = '找到 ' + sorted.length + ' / ' + rawSubmissions.length + ' 条';
    } else {
      mineCount.textContent = '共 ' + rawSubmissions.length + ' 条';
    }

    if (!sorted.length) {
      var emptyFiltered = document.createElement('div');
      emptyFiltered.className = 'mine-empty-filtered';
      emptyFiltered.innerHTML = '<p>没有找到符合筛选条件的提交</p><button type="button" class="btn btn--sm btn--ghost" id="reset-filter-btn">重置筛选</button>';
      emptyFiltered.querySelector('#reset-filter-btn').addEventListener('click', resetFilters);
      box.appendChild(emptyFiltered);
      return;
    }

    sorted.forEach(view === 'trash' ? renderTrashCard : renderActiveCard);
  }

  function resetFilters() {
    currentStatus = 'all';
    currentSinger = null;
    searchQuery = '';
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.hidden = true;
    var tabs = statusRow.querySelectorAll('.mine-status-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-status') === 'all');
    }
    var singerLabel = document.getElementById('singer-filter-label');
    if (singerLabel) singerLabel.textContent = '全部歌手';
    updateControls();
    render();
  }

  function loadSingers() {
    if (singersLoaded) return Promise.resolve();
    return fetch('/api/singers')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        (list || []).forEach(function (s) {
          singerMap[s.id] = s.name_zh || s.name_en || s.id;
        });
        singersLoaded = true;
      })
      .catch(function () {});
  }

  function load() {
    var url = view === 'trash' ? '/api/my-submissions?status=trash' : '/api/my-submissions';
    if (view === 'list') showSongFlash();
    loadSingers().then(function () {
      return fetch(url).then(function (r) { return r.json(); });
    }).then(function (list) {
      rawSubmissions = list || [];
      if (rawSubmissions.length) {
        var sorted = rawSubmissions.slice().sort(function (a, b) {
          return (b.created_at || '').localeCompare(a.created_at || '');
        });
        if (sorted[0] && sorted[0].singer) {
          try { localStorage.setItem('last_submitted_singer', sorted[0].singer); } catch (e) {}
        }
      }
      updateControls();
      render();
    }).catch(function () {
      box.hidden = false;
      box.innerHTML = '<p class="form-err">加载失败，请刷新重试</p>';
    });
  }

  function setView(v) {
    view = v;
    var tabs = views.querySelectorAll('.mine-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === view);
    }
    currentStatus = 'all';
    var stTabs = statusRow.querySelectorAll('.mine-status-tab');
    for (var j = 0; j < stTabs.length; j++) {
      stTabs[j].classList.toggle('active', stTabs[j].getAttribute('data-status') === 'all');
    }
    load();
  }

  function initStatusTabs() {
    if (!statusRow) return;
    var tabs = statusRow.querySelectorAll('.mine-status-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        t.addEventListener('click', function () {
          currentStatus = t.getAttribute('data-status');
          for (var j = 0; j < tabs.length; j++) {
            tabs[j].classList.toggle('active', tabs[j] === t);
          }
          render();
        });
      })(tabs[i]);
    }
  }

  function initSortToggle() {
    if (!sortToggle) return;
    sortToggle.addEventListener('click', function () {
      currentSort = currentSort === 'newest' ? 'oldest' : 'newest';
      var sortLabel = document.getElementById('sort-label');
      var sortArrow = document.getElementById('sort-arrow');
      if (sortLabel) sortLabel.textContent = currentSort === 'newest' ? '年份倒序' : '年份正序';
      if (sortArrow) sortArrow.textContent = currentSort === 'newest' ? '▾' : '▴';
      render();
    });
  }

  function initSingerDropdown() {
    if (!singerFilterBtn || !singerFilterMenu) return;

    singerFilterBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = singerFilterMenu.hidden;
      singerFilterMenu.hidden = !willOpen;
      singerFilterBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });

    document.addEventListener('click', function (e) {
      var dropdown = document.getElementById('singer-filter');
      if (dropdown && !dropdown.contains(e.target)) {
        singerFilterMenu.hidden = true;
        singerFilterBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !singerFilterMenu.hidden) {
        singerFilterMenu.hidden = true;
        singerFilterBtn.setAttribute('aria-expanded', 'false');
        singerFilterBtn.focus();
      }
    });
  }

  function initSearchBox() {
    if (!searchInput || !searchClear) return;

    function syncClear() { searchClear.hidden = searchInput.value === ''; }

    searchInput.addEventListener('input', function () {
      syncClear();
      searchQuery = this.value.trim();
      render();
    });

    searchClear.addEventListener('click', function () {
      searchInput.value = '';
      searchQuery = '';
      syncClear();
      render();
      searchInput.focus();
    });

    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && searchInput.value) {
        searchInput.value = '';
        searchQuery = '';
        syncClear();
        render();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    Auth.renderAuthLink(document.getElementById('auth-link'));
    Auth.requireSession(document.getElementById('auth-gate'), function () {
      if (controls) controls.hidden = false;
      var vTabs = views.querySelectorAll('.mine-tab');
      for (var i = 0; i < vTabs.length; i++) {
        (function (b) {
          b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
        })(vTabs[i]);
      }
      initStatusTabs();
      initSortToggle();
      initSingerDropdown();
      initSearchBox();
      load();
    });
  });
})();
