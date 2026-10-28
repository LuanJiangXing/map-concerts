/* yearbar.js —— 年份跨度条(可复用组件,2026-09-10 S4b)
 *
 * 把「时间」变成一等公民:2000–2026 每年一格 —— 有演出的年份按场次加高,
 * 无演出的年份以极短淡刻度存在,让「跨度长、分布稀疏」一眼可见。
 *
 * 组件边界(供首页 S4c 复用):
 *   本文件**不认识标签/筛选/地图**,只负责渲染与交互回调:
 *     window.YearBar.create(hostEl, {
 *       years:       [2000, 2001, …],   // 完整刻度(升序,含无演出年份)
 *       ariaLabel:   '按年份筛选演出',
 *       summary:     '48 场演出 · 37 个城市',
 *       onToggle:    function(year){},  // 点某年(调用方决定选中/取消语义)
 *       onClear:     function(){}       // 可选;提供则显示「全部」重置钮
 *     }) -> {
 *       update({ counts, selected, activeYears, summary }),
 *       root: HTMLElement
 *     }
 *
 *   状态由调用方持有:counts 决定强度、selected 决定选中态、
 *   activeYears 决定哪些年份可点(其余 tabindex=-1 跳过、hover 仍出提示)。
 *   这样歌手页可接 selectedTagsByCategory(年份标签),首页可接导航回调,
 *   同一份视觉与键盘语义,不复制第二套。
 *
 * 无障碍:可 Tab / Enter / Space(原生 button),aria-pressed 表选中,
 *   aria-label 带场次,悬停/聚焦共用一枚 tooltip(复用站上 .map-tip 观感)。
 */
(function () {
  'use strict';

  function create(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var years = (opts.years || []).slice();
    var onToggle = opts.onToggle || function () {};
    var onClear = opts.onClear || null;
    var ariaLabel = opts.ariaLabel || '按年份筛选';

    var state = {
      counts: {},
      selected: new Set(),
      activeYears: new Set(),
      summary: opts.summary || ''
    };

    host.innerHTML = '';
    var root = document.createElement('div');
    root.className = 'yearbar';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', ariaLabel);

    /* ---- 头部:时间范围 + 结果摘要 + 「全部」重置 ---- */
    var head = document.createElement('div');
    head.className = 'yearbar__head';

    var range = document.createElement('span');
    range.className = 'yearbar__range';
    head.appendChild(range);

    var summary = document.createElement('span');
    summary.className = 'yearbar__summary';
    summary.setAttribute('role', 'status'); // 筛选结果变化即播报
    summary.setAttribute('aria-live', 'polite');
    head.appendChild(summary);

    var reset = null;
    if (onClear) {
      reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'yearbar__reset';
      reset.textContent = '全部';
      reset.addEventListener('click', function () { onClear(); });
      head.appendChild(reset);
    }

    /* ---- 刻度:每年一格,一次性建好,后续只更新属性(避免重建导致焦点丢失) ---- */
    var track = document.createElement('div');
    track.className = 'yearbar__track';

    var ticks = {};
    years.forEach(function (y) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'yearbar__year';
      b.dataset.year = String(y);
      // 窄屏只保留整五年的标签(见 CSS ≤900px),其余仅刻度
      if (y % 5 === 0 || y === years[0] || y === years[years.length - 1]) b.classList.add('is-major');

      var bar = document.createElement('span');
      bar.className = 'yearbar__bar';
      var num = document.createElement('span');
      num.className = 'yearbar__num';
      num.textContent = String(y);
      b.appendChild(bar);
      b.appendChild(num);
      b.addEventListener('click', function () {
        if (b.getAttribute('aria-disabled') === 'true') return;
        onToggle(y);
      });
      track.appendChild(b);
      ticks[y] = { el: b, bar: bar, num: num };
    });

    /* ---- 悬停/聚焦 tooltip(与 .map-tip 同观感,不新造一套视觉) ---- */
    var tip = document.createElement('div');
    tip.className = 'yearbar__tip';
    tip.hidden = true;
    // 提示内容已由每格 aria-label 承载,隐藏以免读屏重复播报(P3,2026-09-10)
    tip.setAttribute('aria-hidden', 'true');

    root.appendChild(head);
    root.appendChild(track);
    root.appendChild(tip);
    host.appendChild(root);

    function tickFromEvent(e) {
      var t = e.target;
      while (t && t !== track) {
        if (t.classList && t.classList.contains('yearbar__year')) return t;
        t = t.parentNode;
      }
      return null;
    }
    function positionTip(el) {
      var tw = tip.offsetWidth;
      // 容器比提示还窄时无处可夹 → 直接隐藏,绝不外溢撑滚动条
      if (tw + 4 > root.offsetWidth) { tip.hidden = true; tipYear = null; return; }
      var tr = el.getBoundingClientRect();
      var cr = root.getBoundingClientRect();
      var left = tr.left - cr.left + tr.width / 2;
      left = Math.max(tw / 2 + 2, Math.min(root.offsetWidth - tw / 2 - 2, left));
      tip.style.left = left + 'px';
      tip.style.top = (tr.top - cr.top - tip.offsetHeight - 6) + 'px';
    }
    var tipYear = null;
    function showTip(y) {
      var t = ticks[y];
      if (!t) return;
      var n = state.counts[y] || 0;
      tip.textContent = String(y) + ' 年 · ' + n + ' 场';
      tip.hidden = false;
      tipYear = y;
      positionTip(t.el);
    }
    function hideTip() { tip.hidden = true; tipYear = null; }
    /* 视口变化(窗口缩放 / 设备旋转 / 页面缩放)时绝对定位的提示框会停在旧坐标:
       桌面算好的 left 在视口缩到 375px 后仍留在原处 → 撑出页面级横向滚动(P1,2026-09-10)。
       按当前刻度重新夹取,既消除溢出,也保留正在聚焦年份的提示。 */
    window.addEventListener('resize', function () {
      if (!tip.hidden && tipYear != null && ticks[tipYear]) positionTip(ticks[tipYear].el);
    });

    track.addEventListener('pointerover', function (e) {
      var b = tickFromEvent(e); if (b) showTip(Number(b.dataset.year));
    });
    track.addEventListener('pointermove', function (e) {
      var b = tickFromEvent(e); if (b) showTip(Number(b.dataset.year));
    });
    track.addEventListener('pointerleave', hideTip);
    track.addEventListener('focusin', function (e) {
      var b = tickFromEvent(e);
      if (!b) return;
      var y = Number(b.dataset.year);
      if (rovingKey !== y) { rovingKey = y; rovingPinned = true; applyRoving(); }
      showTip(y);
    });
    track.addEventListener('focusout', hideTip);
    root.addEventListener('pointerleave', hideTip);

    /* ---- roving tabindex(P3,2026-09-10):整组(「全部」+ 可点年份)只占 1 个
       Tab 停靠点,组内 ←/→(及 ↑/↓)移动、Home/End 跳首尾年份 —— 修掉全站最长的
       Tab 通道(原 1 重置 + N 年份)。空年不进 roving 序、tabindex 恒 -1;
       Enter/Space 切换、aria-pressed 与提示框显隐语义不变。 ---- */
    var rovingKey = null;   // 当前持有 tabindex=0 的项:'reset' 或年份数字
    var rovingPinned = false; // 用户是否已显式定位过(否则跟随「首个可点年份」)
    function orderedKeys() {
      var keys = [];
      if (reset) keys.push('reset');
      years.forEach(function (y) {
        if (state.activeYears && state.activeYears.has(y)) keys.push(y);
      });
      return keys;
    }
    function elForKey(key) {
      return key === 'reset' ? reset : (ticks[key] ? ticks[key].el : null);
    }
    function applyRoving() {
      if (reset) reset.tabIndex = rovingKey === 'reset' ? 0 : -1;
      years.forEach(function (y) {
        var t = ticks[y]; if (!t) return;
        var active = !!(state.activeYears && state.activeYears.has(y));
        t.el.tabIndex = (active && rovingKey === y) ? 0 : -1;
      });
    }
    function normalizeRoving() {
      var keys = orderedKeys();
      var firstYear = null;
      for (var i = 0; i < keys.length; i++) { if (keys[i] !== 'reset') { firstYear = keys[i]; break; } }
      // 未显式定位过 → 默认停靠「首个可点年份」;显式定位过且仍有效 → 保持原位
      if (!(rovingPinned && keys.indexOf(rovingKey) !== -1)) {
        rovingKey = firstYear != null ? firstYear : (keys.indexOf('reset') !== -1 ? 'reset' : null);
      }
    }
    function focusKey(key) {
      var el = elForKey(key);
      if (!el) return;
      rovingKey = key;
      rovingPinned = true;
      applyRoving();
      el.focus();
      if (key !== 'reset') showTip(Number(key));
    }
    function moveRoving(delta) {
      var keys = orderedKeys();
      if (!keys.length) return;
      var idx = keys.indexOf(rovingKey);
      if (idx === -1) idx = 0;
      var next = idx + delta;
      if (next < 0 || next >= keys.length) return; // 不环绕
      focusKey(keys[next]);
    }
    function jumpToYear(last) {
      var ys = [];
      years.forEach(function (y) { if (state.activeYears && state.activeYears.has(y)) ys.push(y); });
      if (!ys.length) return;
      focusKey(last ? ys[ys.length - 1] : ys[0]);
    }
    function onKeydown(e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); moveRoving(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); moveRoving(-1); }
      else if (e.key === 'Home') { e.preventDefault(); jumpToYear(false); }
      else if (e.key === 'End') { e.preventDefault(); jumpToYear(true); }
    }
    root.addEventListener('keydown', onKeydown);
    if (reset) {
      reset.addEventListener('focus', function () {
        if (rovingKey !== 'reset') { rovingKey = 'reset'; rovingPinned = true; applyRoving(); }
      });
    }

    function update(next) {
      next = next || {};
      if (next.counts) state.counts = next.counts;
      if (next.selected) state.selected = next.selected;
      if (next.activeYears) state.activeYears = next.activeYears;
      if (next.summary != null) { state.summary = next.summary; summary.textContent = next.summary; }

      if (range) range.textContent = years.length ? (years[0] + '–' + years[years.length - 1]) : '';

      var max = 1;
      years.forEach(function (y) { var c = state.counts[y] || 0; if (c > max) max = c; });

      var anySel = !!(state.selected && state.selected.size > 0);
      if (reset) {
        // 静息态(无年份选中)= 普通外观;确有年份选中才高亮 + aria-pressed=true
        // (P3,2026-09-10:原为反相,静息态看起来像"已经选了全部")
        reset.setAttribute('aria-pressed', anySel ? 'true' : 'false');
        reset.classList.toggle('is-active', anySel);
      }

      years.forEach(function (y) {
        var t = ticks[y];
        if (!t) return;
        var c = state.counts[y] || 0;
        var sel = !!(state.selected && state.selected.has(y));
        var active = !!(state.activeYears && state.activeYears.has(y));
        // 高度编码强度:0 场 = 3px 淡刻度;有场次 6–28px
        t.bar.style.height = (c <= 0 ? 3 : Math.round(6 + 22 * (c / max))) + 'px';
        t.bar.style.background = c <= 0 ? 'var(--yearbar-empty)' : 'var(--accent)';
        t.el.classList.toggle('is-empty', c <= 0);
        t.el.classList.toggle('is-selected', sel);
        t.el.setAttribute('aria-pressed', sel ? 'true' : 'false');
        t.el.setAttribute('aria-label', y + ' 年, ' + c + ' 场演出' + (sel ? ', 已选中' : ''));
        if (active) {
          t.el.removeAttribute('aria-disabled');
          t.el.classList.remove('is-disabled');
        } else {
          t.el.setAttribute('aria-disabled', 'true');
          t.el.classList.add('is-disabled');
        }
      });
      normalizeRoving();
      applyRoving();
    }

    update({ summary: state.summary });
    return { update: update, root: root };
  }

  window.YearBar = { create: create };
})();
