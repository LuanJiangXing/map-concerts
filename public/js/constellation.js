/* public/js/constellation.js —— 首页核心贡献者星图 Canvas 组件
 *
 * 规范与特性:
 *   - 黄金角螺旋排布 (Golden-Angle Spiral, 137.5°) + rankOrder 打散
 *   - 确定性排开防文字重叠 (relaxNodes)
 *   - 节点半径与通过场次平方根成比例映射 (r ∝ √count)
 *   - 动态距离衰减渐变连接线 + 鼠标悬浮高亮连通网络
 *   - 高分屏 DPR 缩放、自适应舞台尺寸
 *   - 视口监听 (IntersectionObserver) 离屏彻底暂停 rAF 循环，节约电量与 CPU
 *   - 无障碍降级 (prefers-reduced-motion) 单帧绘制
 *   - 主题响应 (监听 HTML data-theme 变动重新采样 CSS 变量)
 */
(function (root) {
  'use strict';

  var TAU = Math.PI * 2;
  var GOLDEN_ANGLE = 2.399963229728653;
  var FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  var CONFIG = {
    contributors: { min: 4, max: 20, maxNarrow: 6, narrowPx: 540 },
    speed: 0.28,             // 漂移速度倍率，周期约 21s
    size: 1.0,
    linkRatio: 180 / 920,
    sizeBase: 0.76,          // 折中尺寸基准 (原 0.72 -> 0.82 -> 0.76)
    basePeriodSec: 6.5,
    linkAlpha: 0.44,         // 折中连线透明度 (原 0.42 -> 0.65 -> 0.44)
    linkWidth: { base: 1.3, hover: 2.3 }, // 折中线宽 (原 1.2/2.2 -> 1.8/2.8 -> 1.3/2.3)
    minRadius: 7.0,
    radiusFactor: 5.6,
    radiusFloor: 12,         // 折中最小半径 (原 10 -> 14 -> 12)
    radiusCeil: 40,          // 折中最大半径 (原 36 -> 46 -> 40)
    spreadX: 0.88,
    spreadY: 0.76,
    hoverPad: 14,
    textGap: 7,
    nameMaxW: 220
  };

  var canvas = null, ctx = null, wrap = null, mirror = null;
  var allContributors = [];
  var nodes = [];
  var imgCache = new Map();
  var defaultImgCache = new Map();
  var singerImgCache = new Map();
  var colors = null;

  var width = 0, height = 0, dpr = 1, measured = false;
  var state = { n: CONFIG.contributors.max, speed: CONFIG.speed, size: CONFIG.size, linkRatio: CONFIG.linkRatio };
  var hovered = null;
  var reduced = false, visible = false, running = false, rafId = 0, frameCount = 0;
  var t0 = (root.performance && root.performance.now) ? root.performance.now() : 0;
  var mq = null, io = null, ro = null;

  var DEFAULT_KEYS = ['ball', 'pick', 'mic', 'ticket', 'amp', 'cassette'];

  // 内置 6 款默认头像 SVG 备用(消费 CSS 令牌)
  var FALLBACK_SVG = {
    ball:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="28" y="5" width="8" height="5" rx="1.5" fill="var(--muted)"/>' +
        '<circle cx="32" cy="6" r="2.5" fill="var(--muted)"/>' +
        '<circle cx="32" cy="34" r="21" fill="var(--accent)"/>' +
        '<g fill="none" stroke="var(--panel-2)" stroke-width="1.5" opacity="0.85">' +
          '<path d="M32 13v42"/><ellipse cx="32" cy="34" rx="9" ry="21"/><ellipse cx="32" cy="34" rx="16" ry="21"/><path d="M12 27h40M12 41h40"/>' +
        '</g>' +
      '</svg>',
    pick:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M32 57 C23 45 11 32 11 21 C11 12 21 7 32 7 C43 7 53 12 53 21 C53 32 41 45 32 57 Z" fill="var(--accent)"/>' +
        '<path d="M22 17 C25 13 39 13 42 17" fill="none" stroke="var(--accent-deep)" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg>',
    mic:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="23" y="6" width="18" height="30" rx="9" fill="var(--accent)"/>' +
        '<g stroke="var(--panel-2)" stroke-width="1.6" opacity="0.8"><path d="M25 15h14M25 21h14M25 27h14"/></g>' +
        '<rect x="28" y="33" width="8" height="15" rx="2" fill="var(--muted)"/>' +
        '<rect x="20" y="49" width="24" height="7" rx="3.5" fill="var(--accent-deep)"/>' +
      '</svg>',
    ticket:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M12 16 H52 A4 4 0 0 1 56 20 V27 A5 5 0 0 0 56 37 V44 A4 4 0 0 1 52 48 H12 A4 4 0 0 1 8 44 V37 A5 5 0 0 0 8 27 V20 A4 4 0 0 1 12 16 Z" fill="var(--accent)"/>' +
        '<path d="M40 20 V44" stroke="var(--panel-2)" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round"/>' +
        '<circle cx="24" cy="32" r="6" fill="none" stroke="var(--accent-deep)" stroke-width="2.5"/>' +
      '</svg>',
    amp:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="10" y="7" width="44" height="50" rx="4" fill="var(--accent)"/>' +
        '<rect x="15" y="12" width="34" height="11" rx="2" fill="var(--panel-2)"/>' +
        '<circle cx="20" cy="17.5" r="2.5" fill="var(--accent-deep)"/>' +
        '<circle cx="30" cy="17.5" r="2.5" fill="var(--accent-deep)"/>' +
        '<circle cx="40" cy="17.5" r="2.5" fill="var(--accent-deep)"/>' +
        '<circle cx="32" cy="39" r="14" fill="var(--panel-2)"/>' +
        '<circle cx="32" cy="39" r="6" fill="var(--accent-deep)"/>' +
      '</svg>',
    cassette:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="6" y="17" width="52" height="30" rx="4" fill="var(--accent)"/>' +
        '<rect x="14" y="24" width="36" height="16" rx="2" fill="var(--panel-2)"/>' +
        '<circle cx="22" cy="32" r="5.5" fill="var(--accent-deep)"/>' +
        '<circle cx="42" cy="32" r="5.5" fill="var(--accent-deep)"/>' +
        '<circle cx="22" cy="32" r="2" fill="var(--panel-2)"/>' +
        '<circle cx="42" cy="32" r="2" fill="var(--panel-2)"/>' +
      '</svg>'
  };

  function defaultKeyFor(userId) {
    if (root.Avatars && root.Avatars.defaultKeyFor) {
      return root.Avatars.defaultKeyFor(userId);
    }
    var s = String(userId == null ? '' : userId);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h + s.charCodeAt(i)) % 1000003;
    return DEFAULT_KEYS[h % DEFAULT_KEYS.length];
  }

  function clamp(v, lo, hi) {
    if (hi < lo) hi = lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function isNarrow() {
    return (typeof window !== 'undefined' ? (window.innerWidth || 1000) : 1000) < CONFIG.contributors.narrowPx;
  }

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fb) {
      var val = cs.getPropertyValue(name);
      return (val && val.trim()) || fb;
    }
    return {
      bg: 'transparent',
      border: v('--border', '#2e3340'),
      accent: v('--accent', '#ff8a3d'),
      accent2: v('--accent-2', '#f0863a'),
      accentDeep: v('--accent-deep', '#d35400'),
      text: v('--text', '#e8e6e1'),
      muted: v('--muted', '#9aa0ad'),
      pillBg: v('--panel-2', '#232733'),
      panel: v('--panel', '#1c1f28')
    };
  }

  function svgDataUrl(rawSvg, cs) {
    var c = cs || colors || readColors();
    var accent = c.accent || '#ff8a3d';
    var accentDeep = c.accentDeep || '#d35400';
    var muted = c.muted || '#9aa0ad';
    var panel2 = c.pillBg || '#232733';
    var resolved = rawSvg
      .replace(/var\(--accent-deep\)/g, accentDeep)
      .replace(/var\(--accent\)/g, accent)
      .replace(/var\(--muted\)/g, muted)
      .replace(/var\(--panel-2\)/g, panel2);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(resolved);
  }

  function getDefaultAvatarEntry(key) {
    var k = key || DEFAULT_KEYS[0];
    var cur = defaultImgCache.get(k);
    if (cur) return cur;
    var rawSvg = (root.Avatars && root.Avatars.svg) ? root.Avatars.svg(k) : FALLBACK_SVG[k];
    if (!rawSvg) rawSvg = FALLBACK_SVG[DEFAULT_KEYS[0]];
    var entry = { img: new Image(), state: 'loading' };
    entry.img.onload = function () { entry.state = 'ready'; };
    entry.img.onerror = function () { entry.state = 'failed'; };
    entry.img.src = svgDataUrl(rawSvg, colors);
    defaultImgCache.set(k, entry);
    return entry;
  }

  function reloadDefaultAvatars() {
    defaultImgCache.clear();
    DEFAULT_KEYS.forEach(function (k) {
      getDefaultAvatarEntry(k);
    });
  }

  function contributorAvatarFor(c) {
    var uid = String(c.user_id || c.name);
    var e = imgCache.get(uid);
    if (e) return e;

    var info = (root.Avatars && root.Avatars.resolve)
      ? root.Avatars.resolve(c.avatar_url, c.user_id)
      : { kind: 'default', key: defaultKeyFor(c.user_id) };

    var defKey = info.key || defaultKeyFor(c.user_id);
    var defEntry = getDefaultAvatarEntry(defKey);

    e = {
      kind: info.kind,
      key: defKey,
      img: new Image(),
      state: 'loading',
      defaultEntry: defEntry
    };

    if (info.kind === 'upload' && info.src) {
      e.img.onload = function () { e.state = 'ready'; };
      e.img.onerror = function () { e.state = 'failed'; };
      var src = (root.Auth && root.Auth.avatarSrc) ? root.Auth.avatarSrc(info.src) : info.src;
      e.img.src = src;
    } else {
      e.state = 'default';
    }

    imgCache.set(uid, e);
    return e;
  }

  function singerImgFor(s) {
    var key = String(s.id || s.name || s.portrait);
    var cached = singerImgCache.get(key);
    if (cached) return cached;
    var entry = { img: new Image(), state: 'loading' };
    entry.img.onload = function () { entry.state = 'ready'; };
    entry.img.onerror = function () { entry.state = 'failed'; };
    if (s.portrait) {
      var src = (root.Auth && root.Auth.avatarSrc) ? root.Auth.avatarSrc(s.portrait) : s.portrait;
      entry.img.src = src;
    } else {
      entry.state = 'none';
    }
    singerImgCache.set(key, entry);
    return entry;
  }

  var PHI = 0.6180339887498949;
  function rankOrder(n) {
    var order = new Array(n), used = new Array(n);
    for (var i = 0; i < n; i++) {
      var want = Math.floor((((i * PHI) + 0.5) % 1) * n);
      for (var d = 0; d < n && used[want]; d++) want = (want + 1) % n;
      used[want] = true;
      order[i] = want;
    }
    return order;
  }

  function anchorFor(slot, n, rhoMax) {
    var theta = slot * GOLDEN_ANGLE;
    var rho = rhoMax * Math.sqrt((slot + 0.5) / Math.max(1, n));
    return {
      xR: 0.5 + rho * Math.cos(theta) * CONFIG.spreadX,
      yR: 0.5 + rho * Math.sin(theta) * CONFIG.spreadY
    };
  }

  function sizeFactorFor(w) {
    return clamp(w / 860, 0.55, 1.0);
  }

  function nameSizeFor(r) { return Math.max(12, Math.round(r * 0.34)); }
  function countSizeFor(r) { return Math.max(13, Math.round(r * 0.28)); }

  function radiusFor(count, sf, n) {
    var sampleBoost = (n && n <= 4) ? 1.15 : ((n && n <= 8) ? 1.08 : 1.0);
    return clamp(
      (CONFIG.minRadius + Math.sqrt(Math.max(0, count)) * CONFIG.radiusFactor) * sf,
      CONFIG.radiusFloor,
      CONFIG.radiusCeil
    ) * CONFIG.sizeBase * state.size * sampleBoost;
  }

  var RELAX = { iterations: 14, pad: 8 };

  function labelBox(n) {
    var earW = (n.ears && n.ears.length > 0) ? (n.earDist * Math.SQRT1_2 + n.sr) : 0;
    var halfW = Math.max(n.r, earW, n.nameW / 2, n.countW / 2);
    var topH = (n.nameOffsetY || (n.r + CONFIG.textGap)) + n.nameSize;
    var botH = n.r + CONFIG.textGap + n.countSize + 4;
    return {
      l: n.baseX - halfW,
      r: n.baseX + halfW,
      t: n.baseY - topH,
      b: n.baseY + botH
    };
  }

  function relaxNodes(list) {
    if (list.length < 2) return;
    for (var it = 0; it < RELAX.iterations; it++) {
      for (var i = 0; i < list.length; i++) {
        for (var j = i + 1; j < list.length; j++) {
          var A = list[i], B = list[j];
          var a = labelBox(A), b = labelBox(B);
          var ox = Math.min(a.r, b.r) - Math.max(a.l, b.l) + RELAX.pad;
          var oy = Math.min(a.b, b.b) - Math.max(a.t, b.t) + RELAX.pad;
          if (ox <= 0 || oy <= 0) continue;
          var shift;
          if (ox <= oy) {
            shift = (A.baseX <= B.baseX ? -1 : 1) * ox / 2;
            A.baseX += shift; B.baseX -= shift;
          } else {
            shift = (A.baseY <= B.baseY ? -1 : 1) * oy / 2;
            A.baseY += shift; B.baseY -= shift;
          }
        }
      }
    }
  }

  function truncate(ctx, text, maxW) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) {
      s = s.slice(0, -1);
    }
    return s + '…';
  }

  function buildNodes() {
    if (!measured || !allContributors.length) return;
    var cap = isNarrow() ? CONFIG.contributors.maxNarrow : CONFIG.contributors.max;
    var list = allContributors.slice(0, cap);
    var n = list.length;
    var sf = sizeFactorFor(width);
    var order = rankOrder(n);

    nodes = [];
    var maxR = 0;
    for (var k = 0; k < n; k++) {
      var rTest = radiusFor(list[k].count || 0, sf, n);
      if (rTest > maxR) maxR = rTest;
    }

    var rhoMax = clamp(0.5 - (maxR + 38) / Math.min(width, height), 0.28, 0.48);

    for (var i = 0; i < n; i++) {
      var c = list[i];
      var slot = order[i];
      var anc = anchorFor(slot, n, rhoMax);
      var r = radiusFor(c.count || 0, sf, n);
      var nameSz = nameSizeFor(r);
      var countSz = countSizeFor(r);

      ctx.font = '600 ' + nameSz + 'px ' + FONT_STACK;
      var nameText = truncate(ctx, c.name || '乐迷', CONFIG.nameMaxW);
      var nameW = ctx.measureText(nameText).width;

      ctx.font = '700 ' + countSz + 'px ' + FONT_STACK;
      var countText = (c.count || 0) + ' 场';
      var countW = ctx.measureText(countText).width;

      // 提取主贡献歌手 (至多 2 位，挂载为左上与右上“耳朵”大头照)
      var topSingers = (c.singers || []).slice(0, 2);
      var sr = clamp(Math.round(r * 0.40), 10, 16);
      var earDist = r + sr * 0.85;
      var ears = [];
      var cos45 = Math.SQRT1_2;
      var sin45 = Math.SQRT1_2;

      if (topSingers.length === 1) {
        // 只有 1 位歌手：固定置于左上角 (Top-Left)
        ears.push({
          s: topSingers[0],
          entry: singerImgFor(topSingers[0]),
          side: 'left',
          sr: sr,
          ox: -earDist * cos45,
          oy: -earDist * sin45
        });
      } else if (topSingers.length >= 2) {
        // 2 位歌手：第 1 位在左上角，第 2 位在右上角，形成对称“双耳”
        ears.push({
          s: topSingers[0],
          entry: singerImgFor(topSingers[0]),
          side: 'left',
          sr: sr,
          ox: -earDist * cos45,
          oy: -earDist * sin45
        });
        ears.push({
          s: topSingers[1],
          entry: singerImgFor(topSingers[1]),
          side: 'right',
          sr: sr,
          ox: earDist * cos45,
          oy: -earDist * sin45
        });
      }

      // 抬高用户名 Y 轴偏移量，避开双耳
      var nameOffsetY = (ears.length > 0)
        ? (earDist * sin45 + sr + CONFIG.textGap)
        : (r + CONFIG.textGap);

      nodes.push({
        c: c,
        index: i,
        r: r,
        nameSize: nameSz,
        countSize: countSz,
        nameText: nameText,
        nameW: nameW,
        countText: countText,
        countW: countW,
        topSingers: topSingers,
        sr: sr,
        earDist: earDist,
        ears: ears,
        nameOffsetY: nameOffsetY,
        baseX: anc.xR * width,
        baseY: anc.yR * height,
        x: anc.xR * width,
        y: anc.yR * height,
        phase: (i * 1.618) % TAU,
        ampX: 4 + (i % 3) * 2,
        ampY: 3 + ((i + 1) % 3) * 2,
        entry: contributorAvatarFor(c)
      });
    }

    relaxNodes(nodes);
  }

  function linkPx() {
    var n = nodes.length || (allContributors ? allContributors.length : 4);
    var base = width * state.linkRatio;
    if (n <= 4) {
      return Math.max(base, Math.min(width * 0.46, 480));
    } else if (n <= 8) {
      return Math.max(base, Math.min(width * 0.36, 380));
    } else if (n <= 12) {
      return Math.max(base, Math.min(width * 0.28, 300));
    }
    return base;
  }

  function drawLinks(t) {
    var maxD = linkPx();
    var maxD2 = maxD * maxD;
    ctx.save();
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var A = nodes[i], B = nodes[j];
        var dx = A.x - B.x, dy = A.y - B.y;
        var d2 = dx * dx + dy * dy;
        if (d2 >= maxD2) continue;

        var d = Math.sqrt(d2);
        var norm = 1 - d / maxD;
        var alpha = norm * CONFIG.linkAlpha;

        var isHovered = (hovered && (hovered === A || hovered === B));
        if (isHovered) {
          alpha = Math.min(0.85, alpha * 2.0 + 0.25);
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = CONFIG.linkWidth.hover;
        } else {
          alpha = Math.max(0.12, alpha);
          var grad = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
          grad.addColorStop(0, colors.accent);
          grad.addColorStop(1, colors.accent2);
          ctx.strokeStyle = grad;
          ctx.lineWidth = CONFIG.linkWidth.base;
        }

        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawNode(n, isHover) {
    ctx.save();
    var x = n.x, y = n.y, r = n.r;

    // 1. 头像圆盘背景与外圈描边
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.closePath();

    if (isHover) {
      ctx.shadowColor = colors.accent;
      ctx.shadowBlur = 14;
    }

    ctx.fillStyle = colors.pillBg;
    ctx.fill();

    // 2. 贡献者头像绘制 (优先上传图，次选 6 款内置 SVG，绝不出现首字母)
    var drawnAvatar = false;
    var e = n.entry;
    if (e) {
      if (e.state === 'ready') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r - 1.5, 0, TAU);
        ctx.clip();
        ctx.drawImage(e.img, x - r, y - r, r * 2, r * 2);
        ctx.restore();
        drawnAvatar = true;
      } else if (e.defaultEntry && e.defaultEntry.state === 'ready') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r - 1.5, 0, TAU);
        ctx.clip();
        ctx.drawImage(e.defaultEntry.img, x - r, y - r, r * 2, r * 2);
        ctx.restore();
        drawnAvatar = true;
      }
    }

    if (!drawnAvatar) {
      var fbKey = defaultKeyFor(n.c.user_id);
      var fbEntry = getDefaultAvatarEntry(fbKey);
      if (fbEntry && fbEntry.state === 'ready') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r - 1.5, 0, TAU);
        ctx.clip();
        ctx.drawImage(fbEntry.img, x - r, y - r, r * 2, r * 2);
        ctx.restore();
      }
    }

    // 3. 圆盘描边
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.lineWidth = isHover ? 2.2 : 1.5;
    ctx.strokeStyle = isHover ? colors.accent : colors.border;
    ctx.stroke();

    ctx.shadowBlur = 0;

    // 4. 左上与右上“耳朵”歌手大头照 (无文字，圆盘裁剪，保持恰当距离)
    if (n.ears && n.ears.length > 0) {
      for (var ei = 0; ei < n.ears.length; ei++) {
        var ear = n.ears[ei];
        var ex = x + ear.ox;
        var ey = y + ear.oy;
        var esr = ear.sr;
        var sImg = ear.entry;

        // 耳朵圆盘底色
        ctx.beginPath();
        ctx.arc(ex, ey, esr, 0, TAU);
        ctx.fillStyle = colors.pillBg;
        ctx.fill();

        // 歌手大头照
        if (sImg && sImg.state === 'ready') {
          ctx.save();
          ctx.beginPath();
          ctx.arc(ex, ey, esr - 1.2, 0, TAU);
          ctx.clip();
          ctx.drawImage(sImg.img, ex - esr, ey - esr, esr * 2, esr * 2);
          ctx.restore();
        } else {
          var defSinger = getDefaultAvatarEntry('mic');
          if (defSinger && defSinger.state === 'ready') {
            ctx.save();
            ctx.beginPath();
            ctx.arc(ex, ey, esr - 1.2, 0, TAU);
            ctx.clip();
            ctx.drawImage(defSinger.img, ex - esr, ey - esr, esr * 2, esr * 2);
            ctx.restore();
          }
        }

        // 耳朵描边
        ctx.beginPath();
        ctx.arc(ex, ey, esr, 0, TAU);
        ctx.lineWidth = isHover ? 2.0 : 1.4;
        ctx.strokeStyle = isHover ? colors.accent : colors.border;
        ctx.stroke();
      }
    }

    // 5. 上方昵称 (在耳朵上方居中)
    ctx.font = (isHover ? '700 ' : '600 ') + n.nameSize + 'px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = isHover ? colors.text : colors.muted;
    ctx.fillText(n.nameText, x, y - n.nameOffsetY);

    // 6. 下方场次
    var countY = y + r + CONFIG.textGap;
    ctx.font = '700 ' + n.countSize + 'px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = isHover ? colors.accent : colors.text;
    ctx.fillText(n.countText, x, countY);

    // 7. 悬浮时展示浮动气泡 (主贡献歌手名与场次)
    if (isHover && n.topSingers && n.topSingers.length > 0) {
      var tipText = n.topSingers.map(function (s) {
        return s.name + (s.count ? ' ' + s.count + '场' : '');
      }).join(' · ');
      ctx.font = '600 12px ' + FONT_STACK;
      var tipW = ctx.measureText(tipText).width + 16;
      var tipH = 22;
      var tipY = countY + n.countSize + 6;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x - tipW / 2, tipY, tipW, tipH, 11) : ctx.rect(x - tipW / 2, tipY, tipW, tipH);
      ctx.fillStyle = colors.pillBg;
      ctx.fill();
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = colors.accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tipText, x, tipY + tipH / 2);
    }

    ctx.restore();
  }

  function drawFrame(t) {
    ctx.clearRect(0, 0, width, height);

    var period = (CONFIG.basePeriodSec / state.speed) * 1000;
    var progress = (t % period) / period;
    var angle = progress * TAU;

    // 更新飘移位置 (reduced 时不漂移)
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (reduced) {
        n.x = n.baseX;
        n.y = n.baseY;
      } else {
        var a = angle + n.phase;
        n.x = n.baseX + Math.sin(a) * n.ampX;
        n.y = n.baseY + Math.cos(a * 1.3) * n.ampY;
      }
    }

    // 绘制连线
    drawLinks(t);

    // 绘制非高亮节点
    for (var k = 0; k < nodes.length; k++) {
      if (nodes[k] !== hovered) drawNode(nodes[k], false);
    }

    // 绘制高亮节点置顶
    if (hovered) {
      drawNode(hovered, true);
    }
  }

  function loop(now) {
    if (!running) return;
    frameCount++;
    drawFrame(now - t0);
    rafId = requestAnimationFrame(loop);
  }

  function renderNow() {
    drawFrame(0);
  }

  function maybeStart() {
    if (!running && visible && !reduced && measured && allContributors.length > 0) {
      running = true;
      rafId = requestAnimationFrame(loop);
    }
  }

  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function measure() {
    if (!wrap || !canvas) return;
    var rect = wrap.getBoundingClientRect();
    if (rect.width <= 0) return;

    width = Math.round(rect.width);
    // 高度基准 560px，窄屏适当收紧至 440px
    height = isNarrow() ? 440 : 560;
    dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    measured = true;
    colors = readColors();
    reloadDefaultAvatars();

    buildNodes();
    if (reduced || !visible) renderNow();
  }

  function wireHover() {
    if (!canvas) return;
    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var hit = null;

      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var dx = mx - n.x, dy = my - n.y;
        var rHit = n.r + CONFIG.hoverPad;
        if (dx * dx + dy * dy <= rHit * rHit) {
          hit = n;
          break;
        }
        // 悬浮耳朵区域亦可触发高亮
        if (n.ears && n.ears.length > 0) {
          var earHit = false;
          for (var ei = 0; ei < n.ears.length; ei++) {
            var ear = n.ears[ei];
            var edx = mx - (n.x + ear.ox);
            var edy = my - (n.y + ear.oy);
            var erHit = ear.sr + 6;
            if (edx * edx + edy * edy <= erHit * erHit) {
              earHit = true;
              break;
            }
          }
          if (earHit) {
            hit = n;
            break;
          }
        }
      }

      if (hit !== hovered) {
        hovered = hit;
        canvas.style.cursor = hit ? 'pointer' : 'default';
        if (reduced) renderNow();
      }
    });

    canvas.addEventListener('mouseleave', function () {
      if (hovered) {
        hovered = null;
        canvas.style.cursor = 'default';
        if (reduced) renderNow();
      }
    });
  }

  function observe() {
    // 1. prefers-reduced-motion
    mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    reduced = mq ? mq.matches : false;
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', function (ev) {
        reduced = ev.matches;
        if (reduced) { stop(); renderNow(); }
        else { maybeStart(); }
      });
    }

    // 2. IntersectionObserver (离屏暂停)
    if (window.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        var entry = entries[0];
        visible = entry ? (entry.isIntersecting && entry.intersectionRatio > 0) : true;
        if (visible) maybeStart();
        else stop();
      }, { threshold: 0.05 });
      io.observe(wrap);
    } else {
      visible = true;
      maybeStart();
    }

    // 3. ResizeObserver (舞台自适应)
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () {
        measure();
      });
      ro.observe(wrap);
    } else {
      window.addEventListener('resize', measure);
    }

    // 4. 主题切换重新读取色值
    var themeObserver = new MutationObserver(function () {
      colors = readColors();
      reloadDefaultAvatars();
      if (reduced || !running) renderNow();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function buildMirror(list) {
    if (!mirror) return;
    mirror.innerHTML = '';
    var ul = document.createElement('ul');
    ul.className = 'constellation-mirror__list';
    (list || []).forEach(function (c) {
      var li = document.createElement('li');
      var topStr = (c.singers || []).map(function (s) { return s.name; }).join('、');
      li.textContent = (c.name || '乐迷') + '：' + (c.count || 0) + ' 场现场' + (topStr ? ' (主贡献歌手: ' + topStr + ')' : '');
      ul.appendChild(li);
    });
    mirror.appendChild(ul);
  }

  root.initConstellation = function (list) {
    allContributors = (list || []).slice();
    if (!allContributors.length) return;

    wrap = document.getElementById('constellation-wrap');
    canvas = document.getElementById('constellation-canvas');
    mirror = document.getElementById('constellation-mirror');
    if (!wrap || !canvas) return;

    ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return;

    buildMirror(allContributors);
    wireHover();
    observe();
    measure();
  };

  root.__constellation = {
    getNodes: function () { return nodes; },
    isRunning: function () { return running; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
