/* charts.js —— 后台图表渲染模块(2026-09-15,服务于 review「访问分析」)
 *
 * 组件边界:**本文件不认识业务**。它不知道什么是"访问量""页面占比",只把调用方组装好的
 * 数据画成图;口径、取数、合并("其余 N 页")都由调用方负责。这样「统计」tab 以后要接
 * 同一套图表时不必复制第二份几何。
 *
 *   window.Charts.columns(host, { points, ariaLabel, unit, height })
 *       时间序列 → 柱状图(SVG)。points: [{ label, value, title }]
 *   window.Charts.donut(host, { slices, ariaLabel, unit, center })
 *       构成     → 环形图(SVG)。slices: [{ label, value, title }],上限 4 段(见下)
 *   window.Charts.rankBars(host, { rows, ariaLabel, unit })
 *       排名     → 横条(HTML/CSS)。rows: [{ label, value, meta }]
 *   window.Charts.stackedBars(host, { rows, ariaLabel, unit })
 *       总量拆分 → 堆叠横条(HTML/CSS)。rows: [{ label, parts: [{ value, tone }] }]
 *       tone ∈ {'a','b','approved','pending'},未知值按 'a';tone 只是**类名后缀**,
 *       真正的颜色在 style.css 里消费令牌 —— JS 里不出现任何色值。
 *
 * 为什么两张走 SVG、两张走 CSS:柱状/环形需要几何(坐标、弧线),SVG 是唯一载体;
 * 排名与堆叠只是"两段宽度按比例",HTML flex 更轻、文字天然可选可读、天然响应式。
 *
 * 颜色/字号/圆角:全部由 CSS 类消费 tokens.css 的令牌。本文件**零字面量**
 * (DESIGN.md 硬规则:改视觉的唯一入口是 tokens.css)。SVG 元素不写 fill/stroke 属性。
 *
 * 无障碍:SVG 图 role="img" + aria-label 概述(图元内容对手势/读屏都是不可见的,必须给替代描述);
 * HTML 条图用 role="group"(内容本身就是文本,别再套 role=img 把文字挡在读屏外)。
 * 每个图元再带 <title>(悬停提示);精确数值另有调用方渲染的折叠数据表兜底。
 *
 * 尺寸:按**实测 host.clientWidth** 生成 viewBox。不用固定 viewBox 等比缩放 ——
 * 1000 宽的 viewBox 在 390px 屏上缩到 0.35,12px 轴标签会变成 4px 不可读。
 * 窗口尺寸变化时防抖重绘仍然挂着的实例(参考 yearbar.js:148 的既有做法)。
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var RESIZE_DEBOUNCE = 150;   // ms
  var LABEL_MIN_W = 56;        // x 轴每个标签至少要占的宽度(px),据此抽稀
  var BAR_MAX_W = 26;          // 单根柱最宽(px)
  var BAR_MIN_W = 2;           // 单根柱最窄(px)
  var DONUT_OUTER = 92;
  var DONUT_INNER = 58;
  var DONUT_BOX = 200;

  /* ---------- 工具 ---------- */

  var esc = (window.Auth && window.Auth.esc) || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /** 非负有限数归一:NaN / Infinity / 负数 / 非数字一律 0 —— 画布上不接受这些值,
   *  否则会画出 NaN 属性(负半径、NaN 坐标)导致整块图形消失。 */
  function num(v) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  /** y 轴上限取整到 1/2/5×10ⁿ(全 0 时取 1,避免除零) */
  function niceMax(m) {
    if (!(m > 0)) return 1;
    var e = Math.pow(10, Math.floor(Math.log(m) / Math.LN10));
    var f = m / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
  }

  function el(name, cls) {
    var n = document.createElement(name);
    if (cls) n.className = cls;
    return n;
  }

  function svg(name, attrs) {
    var n = document.createElementNS(NS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function empty(host, msg) {
    var p = el('p', 'empty');
    p.textContent = msg || '暂无数据。';
    host.appendChild(p);
    return p;
  }

  function labelFor(prefix, value, unit) {
    return prefix + ' ' + value + (unit ? ' ' + unit : '');
  }

  /* ---------- 窗口尺寸变化 → 重绘仍然挂着的实例 ---------- */

  var live = [];
  function remember(host, opts, fn) {
    live = live.filter(function (e) { return e.host !== host; });
    live.push({ host: host, opts: opts, fn: fn });
  }
  var rt = null;
  window.addEventListener('resize', function () {
    if (rt) clearTimeout(rt);
    rt = setTimeout(function () {
      live = live.filter(function (e) { return e.host && e.host.isConnected; });
      // 迭代快照:fn 内部会 remember(改 live),不能一边遍历一边改
      live.slice().forEach(function (e) { e.fn(e.host, e.opts); });
    }, RESIZE_DEBOUNCE);
  });

  /* ---------- 柱状图 ---------- */

  function columns(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var pts = (opts.points || []).map(function (p) {
      return { label: String(p.label == null ? '' : p.label), value: num(p.value), title: p.title || '' };
    });
    host.innerHTML = '';
    if (!pts.length) { remember(host, opts, columns); return empty(host); }

    var unit = opts.unit || '';
    var H = opts.height || 220;
    var W = Math.max(240, host.clientWidth || 640);
    var padL = 34, padR = 8, padT = 10, padB = 22;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxV = niceMax(Math.max.apply(null, pts.map(function (p) { return p.value; })));
    var n = pts.length;
    var slot = plotW / n;
    var barW = Math.min(BAR_MAX_W, Math.max(BAR_MIN_W, slot * 0.62));

    var root = el('div', 'chart chart--columns');
    var s = svg('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H,
      role: 'img', 'aria-label': opts.ariaLabel || ('柱状图,共 ' + n + ' 项')
    });

    // 网格线 + y 轴刻度(0/25/50/75/100%)
    for (var k = 0; k <= 4; k++) {
      var gy = padT + plotH * (1 - k / 4);
      s.appendChild(svg('line', {
        x1: padL, y1: gy, x2: W - padR, y2: gy,
        class: k === 0 ? 'chart-grid chart-grid--base' : 'chart-grid'
      }));
      var t = svg('text', { x: padL - 6, y: gy + 3, class: 'chart-tick', 'text-anchor': 'end' });
      t.textContent = String(Math.round(maxV * k / 4));
      s.appendChild(t);
    }

    // 柱 + x 轴标签(标签按可用宽度抽稀,末根保证有标签)
    var step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / LABEL_MIN_W))));
    for (var i = 0; i < n; i++) {
      var p = pts[i];
      var h = p.value / maxV * plotH;
      var x = padL + slot * i + (slot - barW) / 2;
      // 柱顶不倒角:柱高就是数值,顶边即刻度线;倒角会把顶端读矮一点,
      // 且 JS 里写倒角半径要另立一条"数据可视化形状"豁免(见 DESIGN.md 豁免登记 6)。
      var rect = svg('rect', {
        x: x, y: padT + plotH - h, width: barW, height: h, class: 'chart-col'
      });
      var tt = svg('title');
      tt.textContent = p.title || (p.label + ':' + labelFor('', p.value, unit));
      rect.appendChild(tt);
      s.appendChild(rect);

      if (i % step === 0 || i === n - 1) {
        var lb = svg('text', { x: padL + slot * i + slot / 2, y: H - 8, class: 'chart-tick', 'text-anchor': 'middle' });
        lb.textContent = p.label;
        s.appendChild(lb);
      }
    }
    root.appendChild(s);
    host.appendChild(root);
    remember(host, opts, columns);
    return root;
  }

  /* ---------- 环形图 ---------- */

  function polar(cx, cy, r, deg) {
    var a = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function fmtPt(p) { return p[0].toFixed(2) + ' ' + p[1].toFixed(2); }

  /** 环形一段的路径(外弧顺时针 + 内弧逆时针) */
  function arcPath(cx, cy, rOut, rIn, a0, a1) {
    var large = (a1 - a0) > 180 ? 1 : 0;
    var o0 = polar(cx, cy, rOut, a0), o1 = polar(cx, cy, rOut, a1);
    var i1 = polar(cx, cy, rIn, a1), i0 = polar(cx, cy, rIn, a0);
    return 'M' + fmtPt(o0) + ' A' + rOut + ' ' + rOut + ' 0 ' + large + ' 1 ' + fmtPt(o1) +
           ' L' + fmtPt(i1) + ' A' + rIn + ' ' + rIn + ' 0 ' + large + ' 0 ' + fmtPt(i0) + ' Z';
  }

  function donut(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var slices = (opts.slices || []).map(function (p) {
      return { label: String(p.label == null ? '' : p.label), value: num(p.value), title: p.title || '' };
    }).filter(function (p) { return p.value > 0; });
    host.innerHTML = '';
    var total = slices.reduce(function (a, b) { return a + b.value; }, 0);
    if (!slices.length || total <= 0) { remember(host, opts, donut); return empty(host); }

    var unit = opts.unit || '';
    var cx = DONUT_BOX / 2, cy = DONUT_BOX / 2;

    var root = el('div', 'chart chart--donut');
    var s = svg('svg', {
      viewBox: '0 0 ' + DONUT_BOX + ' ' + DONUT_BOX, width: '100%', height: DONUT_BOX,
      role: 'img',
      'aria-label': opts.ariaLabel || ('环形图,共 ' + slices.length + ' 项,合计 ' + total + (unit ? ' ' + unit : ''))
    });

    if (slices.length === 1) {
      // 单段占满 360°:弧的起止点重合,A 弧退化成画不出来的零长弧 —— 必须特判,直接画整环
      // 注意:这里**不能**带 .chart-donut__slice —— 那个类设了 fill,而 CSS 的 fill
      // 会盖掉 fill="none" 属性,整环会被填成实心圆饼。用只设 stroke 的独立类。
      var ring = svg('circle', {
        cx: cx, cy: cy, r: (DONUT_OUTER + DONUT_INNER) / 2,
        fill: 'none',
        'stroke-width': DONUT_OUTER - DONUT_INNER,
        class: 'chart-donut__ring'
      });
      var t1 = svg('title');
      t1.textContent = slices[0].label + ':' + labelFor('', slices[0].value, unit);
      ring.appendChild(t1);
      s.appendChild(ring);
    } else {
      var a = 0;
      slices.forEach(function (p, idx) {
        var sweep = p.value / total * 360;
        var seg = svg('path', {
          d: arcPath(cx, cy, DONUT_OUTER, DONUT_INNER, a, a + sweep),
          class: 'chart-donut__slice chart-ramp-' + (idx + 1)
        });
        var st = svg('title');
        st.textContent = p.label + ' ' + p.value + (unit ? ' ' + unit : '') +
          '(' + Math.round(p.value / total * 100) + '%)';
        seg.appendChild(st);
        s.appendChild(seg);
        a += sweep;
      });
    }

    // 环心写总量:文字落在面板底色上,对比度可控(不像压在某一段扇区上那样随色阶漂移)
    var ct = svg('text', { x: cx, y: cy + 7, class: 'chart-donut__center', 'text-anchor': 'middle' });
    ct.textContent = String(opts.center == null ? total : opts.center);
    s.appendChild(ct);

    root.appendChild(s);
    host.appendChild(root);
    remember(host, opts, donut);
    return root;
  }

  /* ---------- 横条(排名 / 堆叠,HTML) ---------- */

  var TONES = { a: 1, b: 1, approved: 1, pending: 1 };

  function barRow(label, meta) {
    var row = el('div', 'chart-bar');
    var name = el('span', 'chart-bar__name');
    // 标签与元信息各自成元素:标签要能省略号截断,元信息要能另起一行 —— 混在一个文本节点里做不到
    var lab = el('span', 'chart-bar__label');
    lab.textContent = label;
    name.appendChild(lab);
    if (meta) {
      var m = el('span', 'chart-bar__meta');
      m.textContent = meta;
      name.appendChild(m);
    }
    row.appendChild(name);
    return row;
  }

  function rankBars(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var rows = (opts.rows || []).map(function (r) {
      return { label: String(r.label == null ? '' : r.label), value: num(r.value), meta: r.meta || '' };
    });
    host.innerHTML = '';
    if (!rows.length) { remember(host, opts, rankBars); return empty(host); }

    var unit = opts.unit || '';
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; })) || 1;
    var root = el('div', 'chart chart--bars');
    root.setAttribute('role', 'group');   // 内容本身是文本,不套 role=img(那会把文字挡在读屏外)
    root.setAttribute('aria-label', opts.ariaLabel || ('条形图,共 ' + rows.length + ' 项'));

    rows.forEach(function (r) {
      var row = barRow(r.label, r.meta);
      var track = el('span', 'chart-bar__track');
      var fill = el('span', 'chart-bar__fill');
      fill.style.width = Math.round(r.value / max * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      var v = el('span', 'chart-bar__value');
      v.textContent = String(r.value) + (unit ? ' ' + unit : '');
      row.appendChild(v);
      row.setAttribute('aria-label', r.label + ':' + labelFor('', r.value, unit));
      root.appendChild(row);
    });

    host.appendChild(root);
    remember(host, opts, rankBars);
    return root;
  }

  function stackedBars(host, opts) {
    if (!host) return null;
    opts = opts || {};
    var rows = (opts.rows || []).map(function (r) {
      var parts = (r.parts || []).map(function (p) {
        return { value: num(p.value), tone: TONES[p.tone] ? p.tone : 'a' };
      });
      var total = parts.reduce(function (a, b) { return a + b.value; }, 0);
      return { label: String(r.label == null ? '' : r.label), parts: parts, total: total, meta: r.meta || '' };
    }).filter(function (r) { return r.total > 0; });
    host.innerHTML = '';
    if (!rows.length) { remember(host, opts, stackedBars); return empty(host); }

    var unit = opts.unit || '';
    var max = Math.max.apply(null, rows.map(function (r) { return r.total; })) || 1;
    var root = el('div', 'chart chart--bars');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', opts.ariaLabel || ('堆叠条形图,共 ' + rows.length + ' 项'));

    rows.forEach(function (r) {
      var row = barRow(r.label, r.meta);
      var track = el('span', 'chart-bar__track');
      r.parts.forEach(function (p) {
        if (p.value <= 0) return;
        var seg = el('span', 'chart-bar__seg chart-bar__seg--' + p.tone);
        seg.style.width = (p.value / max * 100) + '%';
        track.appendChild(seg);
      });
      row.appendChild(track);
      var v = el('span', 'chart-bar__value');
      v.textContent = String(r.total) + (unit ? ' ' + unit : '');
      row.appendChild(v);
      var desc = r.parts.map(function (p) { return p.tone + ' ' + p.value; }).join('、');
      row.setAttribute('aria-label', r.label + ':合计 ' + labelFor('', r.total, unit) + '(' + desc + ')');
      root.appendChild(row);
    });

    host.appendChild(root);
    remember(host, opts, stackedBars);
    return root;
  }

  window.Charts = {
    columns: columns,
    donut: donut,
    rankBars: rankBars,
    stackedBars: stackedBars
  };
})();
