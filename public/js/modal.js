/* modal.js —— 城市演出弹窗 */

(function (root) {
  'use strict';

  // 当前歌手页上下文(/singer/{id}):建议修改链接带上 ?singer= 供提交页预选
  var singer = (location.pathname.match(/^\/singer\/([A-Za-z0-9_-]+)/) || [])[1];

  function esc(s) {
    if (window.Auth && window.Auth.esc) return window.Auth.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // reaction 六项(Discord 风盖章;无严格语义,见任务 09-08 决策 D1)。
  // display = 自托管 Twemoji(Discord 同款图,CC-BY 4.0;文件见 public/images/twemoji/,后端白名单见 src/reactions.js)。
  // /images/* 走 _headers immutable 缓存头;同 URL 换图需改文件名或手动刷新。
  var REACTIONS = [
    { type: 'goat', file: '1f410', label: 'GOAT' },
    { type: 'skull', file: '1f480', label: 'SKULL' },
    { type: 'heart', file: '2764', label: '爱心' },
    { type: 'thumbdown', file: '1f44e', label: '不喜欢' },
    { type: 'check', file: '2705', label: '打勾' },
    { type: 'cross', file: '274c', label: '打叉' }
  ];
  var _rxBusy = false; // 单飞防连点
  var _fav = new Set();   // 收藏态真源(会话内缓存:本会话已收藏的演出 id);写入后同步,重开弹窗星态一致
  var _favReady = false;  // _fav 已与后端同步(数据预热过或本会话已 toggle)→ 星态只读 _fav,不再用数据里可能过期的 p.favorited 兜底
  var _favBusy = false;   // 收藏 toggle 单飞防连点

  // —— 视频封面懒填(v10,渐进回填) ——
  // 有 meta 的链接随 /api/performances 直接出封面;老数据无 meta → 先文字,弹窗打开时对
  // 「无 cover_url 但白名单 host」的链接顺序调 /api/video-meta,成功且有封面才换装。
  var _coverCache = {};  // 会话内 url → cover_url(懒填成功;弹窗重开直接出封面,不重复请求)
  var _noFill = {};      // 会话内 no-fill(url → true):ok:false/429/无封面 → 本会话不再试
  var LAZY_LIMIT = 5;    // 每开弹窗最多懒填条数(防刷;后端限流 60s/20)

  /** 客户端 host 白名单判定 → 'youtube' | 'bilibili' | ''(镜像 src/video-id.js providerOf 的 host 分支) */
  function clientProvider(url) {
    try {
      var h = new URL(String(url || '').trim()).hostname.toLowerCase();
      if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return 'youtube';
      if (h === 'bilibili.com' || h === 'b23.tv' || h.endsWith('.bilibili.com') || h.endsWith('.b23.tv')) return 'bilibili';
    } catch (e) { /* ignore */ }
    return '';
  }
  /** 平台徽:bilibili → 小电视图标(simple-icons 官方路径,品牌粉);youtube → 「油管」文字。值均为内部安全 HTML/文本。 */
  var BILI_ICON = '<svg class="bili-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#FB7299" d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z"/></svg>';
  function platName(url) {
    return clientProvider(url) === 'youtube' ? '油管' : (clientProvider(url) === 'bilibili' ? BILI_ICON : '');
  }
  /** 可懒填 = 白名单 host(无需客户端解析出 video_id —— b23 等由 /api/video-meta 抓取时补) */
  function canLazyFill(url) {
    return !!clientProvider(url);
  }
  // 图标一律内联 SVG(R12:不用 emoji / Unicode 字符充当图标)
  var PLAY_ICO = '<svg class="ph-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>';
  var CHECK_ICO = '<svg class="ico-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6L9 17l-5-5"/></svg>';

  /** 封面项 HTML(16/9 缩略图 + 小字 label/平台徽;图即链接)。灰占位在 CSS 由 .is-broken 控制显隐。
   *  所有封面同尺寸(2026-09-11):原 S4d 的 .perf-cover--full 让 is_full 封面占更大格,但当时
   *  7 场「整场」演出各自只有这一条链接 —— 同一条弹窗里凑不出「一大多小」,放大只造成跨演出
   *  的尺寸不一致(380×244 vs 160×120,面积 4~4.8 倍),用户报「有些封面明显比其他大」。 */
  function coverHtml(url, label, plat, coverUrl) {
    return '<a class="perf-cover" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="perf-cover__thumb">' +
      '<img class="perf-cover__img" src="' + esc(coverUrl) + '" alt="' + esc(label || '') + '" loading="lazy" referrerpolicy="no-referrer">' +
      '<span class="perf-cover__ph">' + PLAY_ICO + '<span class="ph-txt">' + (plat || '无法加载') + '</span></span>' +
      '</span>' +
      '<span class="perf-cover__meta">' +
      '<span class="perf-cover__label">' + esc(label || '') + '</span>' +
      (plat ? '<span class="perf-cover__plat">' + plat + '</span>' : '') +
      '</span></a>';
  }

  /** 懒填:收集 .perf-links 内「无 cover_url 的文字链接」,顺序调 /api/video-meta?url=,
   *  ok 且有 cover → 换装封面;失败/429/无封面 → 记会话 no-fill 不再试。每开 ≤LAZY_LIMIT 条。
   *  返回 Promise:队列排空时 resolve(open() 的深链定位需在封面换装改高度后复校一次)。
   *  无待填锚点 → 立即 resolve,调用方可无差别 await。 */
  function lazyFillCovers(scope) {
    var anchors = Array.prototype.slice.call((scope || document).querySelectorAll('a.link[data-meta-url]'));
    if (!anchors.length) return Promise.resolve();
    anchors = anchors.slice(0, LAZY_LIMIT);
    return new Promise(function (resolve) {
      (function next(i) {
        if (i >= anchors.length) { resolve(); return; }
        var a = anchors[i];
        var url = a && a.getAttribute('data-meta-url');
        if (!a || !url || _noFill[url] || _coverCache[url]) { next(i + 1); return; }
        fetch('/api/video-meta?url=' + encodeURIComponent(url))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.ok && data.meta && data.meta.cover_url) {
              _coverCache[url] = data.meta.cover_url; // 本会话缓存,弹窗重开直接出封面
              a.outerHTML = coverHtml(url, a.getAttribute('data-label') || '', platName(url), data.meta.cover_url);
            } else {
              _noFill[url] = true; // ok:false(上游/无封面)/429 → 本会话不再试
            }
          })
          .catch(function () { _noFill[url] = true; })
          .then(function () { next(i + 1); });
      })(0);
    });
  }

  /** 曲目区(S4d):从原 .perf-links 内的 <details class="perf-tracks"> 提出为独立 section,
   *  有 setlist 的场次默认展开(无需点击即可见)。行内标记与 v10 逐字节一致,仅容器变了:
   *  单 P → 每行仅 ?t=;多 P(存在 part>1)→ 每行前置 P 徽、跳转带 ?p=N&t=。
   *  极长 setlist 不做人为截断/折叠:它是档案馆最难替代的内容,弹窗 body 自身滚动承载。 */
  function buildSetlist(baseUrl, tracks) {
    var multiP = false;
    for (var i = 0; i < tracks.length; i++) {
      if ((tracks[i].part || 1) > 1) { multiP = true; break; }
    }
    var html = '<section class="perf-setlist" aria-label="曲目列表">' +
      '<h4 class="perf-setlist__title">曲目 · ' + tracks.length + ' 首</h4>' +
      '<ol class="perf-setlist__list">';
    tracks.forEach(function (t) {
      var tp = t.part || 1;
      var tm = window.TrackTime.format(t.seconds);
      var label = (multiP ? '<span class="part-badge">P' + tp + '</span>' : '') +
        '<span class="tm">' + esc(tm) + '</span><span>' + esc(t.name) + '</span>';
      html += '<li>';
      if (t.seconds != null) {
        html += '<a class="perf-track" href="' + esc(window.TrackTime.jumpUrl(baseUrl, t.seconds, tp)) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      } else {
        html += '<span class="perf-track none">' + label + '</span>';
      }
      html += '</li>';
    });
    html += '</ol></section>';
    return html;
  }

  /** 「类型」类别标签作醒目 badge,其余标签渲染为小 chip(R6)。
   *  S4d 结构:头部(徽标 + 大号日期 + 收藏)— 标题独占行 — 场馆次要行 — 标签/备注 —
   *  视频链接(封面网格,整场占更大格)— setlist 独立区(默认展开)— 细分隔线下 reactions + 署名。 */
  function buildPerf(p) {
    var tags = p.tags || [];
    var typeTag = null;
    var otherTags = [];
    tags.forEach(function (t) {
      if (t.category_name === '类型') typeTag = t;
      else if (t.category_name === '年份') { /* 年份是结构化字段的影子,不再作为标签出现 */ }
      else otherTags.push(t);
    });
    var hasSong = tags.some(function (t) { return t.category_name === '歌曲'; });
    var typeLabel = typeTag ? typeTag.name : (p.type || '演出');
    // 本人提交的演出 → 动作直接叫「修改」(仍走 ?draft= 草稿合并流,与我的提交一致)
    var actLabel = p.mine ? '修改' : '建议修改 / 补充';

    var html = '<article class="perf" data-perf-id="' + esc(p.id) + '">';
    // 头部:形式徽标 + 大号日期(Archivo tabular,视觉锚点)+ 收藏星标(右端)
    html += '<div class="perf-top">';
    html += '<span class="badge type" data-type="' + esc(typeLabel) + '">' + esc(typeLabel) + '</span>';
    html += '<time class="perf-date">' + esc(p.date || (p.year || '')) + '</time>';
    // 收藏星标(仅 p.id 卡;登录用户可收藏,游客点按 → 登录引导)。星态 = 会话 _fav 真源;未预热(首次 open 前)
    // 才用数据 p.favorited 兜底。只插 .perf-top 右端(margin-left:auto),保持 .perf-top 末位为 .perf-fav 的契约(D4)。
    if (p.id) {
      html += '<button type="button" class="perf-share" data-perf-id="' + esc(p.id) + '"' +
        ' title="复制演出链接" aria-label="复制演出链接">' +
        (root.Icons ? root.Icons.get('share') : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 17v-1a5 5 0 0 1 5-5h8"/><polyline points="13 7 17 11 13 15"/></svg>') +
        '</button>';
      var favOn = _favReady ? _fav.has(p.id) : (_fav.has(p.id) || !!p.favorited);
      html += '<button type="button" class="perf-fav' + (favOn ? ' on' : '') + '" data-perf-id="' + esc(p.id) + '"' +
        ' aria-pressed="' + (favOn ? 'true' : 'false') + '" title="收藏">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.6-6.2 3.6 1.6-7L2 9.2l7.1-.6z"/></svg>' +
        '</button>';
    }
    html += '</div>';
    // 标题独占一行;场馆降为标题下方一行次要信息(修 P2:原 title+place 同行时 .perf-place 的
    // nowrap/flex-shrink:0 会在 375px 把长标题压成一字一行)
    html += '<div class="perf-head">' +
      '<h3 class="perf-title">' + esc(p.title) + '</h3>' +
      (p.venue ? '<p class="perf-place">' + esc(p.venue) + '</p>' : '') +
      '</div>';
    if (otherTags.length) {
      html += '<div class="perf-tags">' + otherTags.map(function (t) {
        return '<span class="tag-chip static">' + esc(t.name) + '</span>';
      }).join('') + '</div>';
    }
    if (p.note) html += '<p class="perf-note">' + esc(p.note) + '</p>';
    if (p.verified) html += '<p class="perf-verified">' + CHECK_ICO + '已核实</p>';
    // 主体 1:视频(有封面 → 封面网格,整场/主视频占更大格;无封面 → 一行文字链)
    // setlist 收集到独立区,不再嵌在 .perf-links 内的 <details> 里
    var setlistHtml = '';
    // 修复 4:setlist 是「演出自身的属性」(p.tracks 挂在演出上,不在链接上),只渲染一次。
    // 只有当一场存在多个 is_full 链接时才有区别:否则会渲出两块逐字重复的「曲目 · N 首」。
    // 归给第一个 is_full —— 逐曲跳转 base 取第一个整场链接的 url,与修复前单整场场次逐字一致。
    var setlistDone = false;
    html += '<div class="perf-links">';
    if (p.links && p.links.length) {
      p.links.forEach(function (link) {
        // v10:有 meta 封面(数据 cover_url 或本会话懒填缓存)→ 封面即链接(替代纯文字);
        // 无封面/placeholder → 维持文字 .link(点击仍跳原视频)
        var cov = (!link.placeholder && (link.cover_url || _coverCache[link.url])) || '';
        var isFull = !!link.is_full;
        if (cov) {
          html += coverHtml(link.url, link.label, platName(link.url), cov);
        } else {
          html += '<a class="link" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer"';
          if (!link.placeholder && canLazyFill(link.url) && !_noFill[link.url] && !_coverCache[link.url]) {
            // 无 meta 但白名单 → 留给懒填渐进回填(有 data-meta-url 才会被 lazyFillCovers 收集)
            html += ' data-meta-url="' + esc(link.url) + '" data-label="' + esc(link.label || '') + '"';
          }
          html += '>' + esc(link.label) + ' ↗</a>';
        }
        // 整场视频链接 + 逐曲时间轴 → setlist 独立区(2026-09-07 契约沿用;2026-09-10 S4d 由
        // <details> 提出为默认展开的 section)。多 P → 每行 P 徽 + ?p=&t=;单 P → 仅 ?t=(逐字节同 v10)。
        // 仅第一个 is_full 承载 setlist(修复 4):后续整场链接只渲封面/文字链,不重复曲目区。
        if (isFull && !setlistDone && p.tracks && p.tracks.length && window.TrackTime) {
          setlistHtml += buildSetlist(link.url, p.tracks);
          setlistDone = true;
        }
      });
    } else {
      html += '<span class="link none">暂无链接</span>';
    }
    html += '</div>';
    html += setlistHtml;
    // 主体 2:reactions + 署名 —— 收在一条细分隔线下,视觉弱化
    if (p.id) {
      // reaction 行:计数/自己高亮由 open() 拉取 /api/reactions 后填充(占位保持常驻点击入口)
      html += '<div class="perf-reactions" data-perf-id="' + esc(p.id) + '"></div>';
    }
    // 无歌曲提示(reaction 之下、底部动作行之上)
    if (!hasSong) {
      html += '<p class="perf-songs-empty">本条尚未收录歌曲 —— 欢迎补上曲目。</p>';
    }
    if (p.id) {
      // 底部动作行:建议修改/补充(左)+ 贡献署名(同行右侧)。署名「由 A 提交 · 修订 B、C」累计口径(09-08 决策 D3);editors 来自后端已排除作者
      var draftHref = '/submit?draft=' + encodeURIComponent(p.id);
      if (singer) draftHref += '&singer=' + encodeURIComponent(singer);
      var creditBits = [];
      if (p.submitted_by) creditBits.push('由 ' + esc(p.submitted_by) + ' 提交');
      var editors = (p.editors || []).filter(function (n) { return n && n !== p.submitted_by; });
      if (editors.length) creditBits.push('修订 ' + editors.map(esc).join('、'));
      html += '<div class="perf-foot">';
      html += '<div class="perf-edit"><a href="' + draftHref + '">' + esc(actLabel) + '</a></div>';
      if (creditBits.length) html += '<div class="perf-credit">' + creditBits.join(' · ') + '</div>';
      html += '</div>';
    }
    html += '</article>';
    return html;
  }

  /** 渲染一条 reaction 条:六按钮 + 计数(0 也显)+ 自己点过的高亮;Twemoji PNG 图标 */
  function renderReactions(el, state) {
    var counts = (state && state.counts) || {};
    var mine = (state && state.mine) || [];
    var mineSet = {};
    mine.forEach(function (t) { mineSet[t] = true; });
    el.innerHTML = REACTIONS.map(function (r) {
      return '<button type="button" class="rt-btn' + (mineSet[r.type] ? ' on' : '') + '" data-type="' + r.type + '" title="' + esc(r.label) + '">' +
        '<img class="rt-ico" src="/images/twemoji/' + r.file + '.png" alt="" loading="lazy" width="16" height="16">' +
        '<span class="rt-n">' + (counts[r.type] || 0) + '</span></button>';
    }).join('');
  }

  /** 反应计数缓存/预取:歌手数据加载完即整批预取(见 prefetchReactions),弹窗打开直接读缓存同步出按钮。 */
  var _rxCache = {};    // id → {counts, mine}(已取到)
  var _rxFetching = {}; // id → true(请求在途,防重发)
  var _rxChunk = 50;    // 与后端 GET ids 上限一致

  /** 用缓存(缺则空态)重绘当前弹窗内所有反应条 —— 同步执行,与弹窗其它 UI 同帧出现 */
  function paintReactionBars() {
    var bars = document.querySelectorAll('#modal-body .perf-reactions');
    for (var i = 0; i < bars.length; i++) {
      var el = bars[i];
      renderReactions(el, _rxCache[el.getAttribute('data-perf-id')]);
    }
  }

  /** 拉缺失 id 的计数(≤50/批),回填缓存后重绘;在途 id 跳过,避免重复请求 */
  function ensureCounts(ids) {
    var need = ids.filter(function (id) { return id && !_rxCache[id] && !_rxFetching[id]; });
    for (var i = 0; i < need.length; i += _rxChunk) {
      (function (chunk) {
        chunk.forEach(function (id) { _rxFetching[id] = true; });
        fetch('/api/reactions?ids=' + encodeURIComponent(chunk.join(',')))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.reactions) {
              Object.keys(data.reactions).forEach(function (id) { _rxCache[id] = data.reactions[id]; });
              paintReactionBars();
            }
          })
          .catch(function () {})
          .then(function () { chunk.forEach(function (id) { delete _rxFetching[id]; }); });
      })(need.slice(i, i + _rxChunk));
    }
  }

  /** 提前加载:歌手数据加载完整批预取该歌手全部演出的反应计数(一次请求,弹窗打开即用缓存) */
  function prefetchReactions(ids) {
    ensureCounts((ids || []).filter(Boolean));
  }

  /** 提前灌收藏态:歌手数据加载完成后把 favorited=true 的 id 写入 _fav(镜像 prefetchReactions 调用点);
   *  数据带出的 favorited 是请求时刻真值,会话内后续 toggle 以 _fav 为准。 */
  function prefetchFavorites(items) {
    (items || []).forEach(function (i) {
      if (i && i.id && i.favorited) _fav.add(i.id);
    });
    _favReady = true; // 预热后 _fav 即与后端一致 → 后续星态以 _fav 为唯一真源
  }

  /** 行内小提示(登录引导 / 失败反馈;本站无 toast 组件,用反应条内弱提示,2.6s 后消失) */
  function reactNote(el, html, extra) {
    var prev = el.querySelector('.perf-react-note');
    if (prev) prev.parentNode.removeChild(prev);
    var note = document.createElement('span');
    note.className = 'perf-react-note' + (extra ? ' ' + extra : '');
    note.innerHTML = html;
    el.appendChild(note);
    setTimeout(function () { if (note.parentNode) note.parentNode.removeChild(note); }, 2600);
  }

  /** 点按瞬时反馈:底色短暂高亮后自动复原(登录引导/会话失效用,不产生真实记录)。cls 默认 reaction 的 rt-flash */
  function flashBtn(btn, cls) {
    if (!btn) return;
    cls = cls || 'rt-flash';
    btn.classList.add(cls);
    setTimeout(function () { btn.classList.remove(cls); }, 650);
  }

  /** 收藏星标点击(modal-body 委托 .perf-fav 分支)。已收藏再点 = DELETE 取消;否则 POST 收藏。
   *  登录确认后先乐观翻星(_fav/按钮立即到目标态),再异步同步;失败/401/429/网络 → 回滚点击前态 + 提示。
   *  未登录 → flash + 行内「登录后可收藏 · 去登录」且绝不翻星;成功以服务端 favorited 校正(_favReady=true)。 */
  function handleFavClick(btn) {
    if (_favBusy) return;
    var perfId = btn.getAttribute('data-perf-id');
    if (!perfId) return;
    var wasOn = btn.classList.contains('on');
    var host = btn.closest('.perf');
    var noteHost = host ? host.querySelector('.perf-reactions') : null;
    var note = function (html, extra) { if (noteHost) reactNote(noteHost, html, extra); };
    /** 把星态置为 fav:_fav(会话真源)+ 星标 .on/aria-pressed。乐观翻转 / 服务端校正 / 失败回滚共用。
     *  按 data-perf-id 找现开弹窗里的钮 —— 请求期间若重开弹窗,校正/回滚仍作用到新钮;找不到(弹窗已关)则只改 _fav,下次重开渲染即对。 */
    function setFav(fav) {
      if (fav) _fav.add(perfId); else _fav.delete(perfId);
      var cur = document.querySelector('#modal-body .perf-fav[data-perf-id="' + perfId + '"]') || btn;
      cur.classList.toggle('on', fav);
      cur.setAttribute('aria-pressed', fav ? 'true' : 'false');
    }
    window.Auth.me().then(function (u) {
      if (!u) { flashBtn(btn, 'fav-flash'); note('登录后可收藏 · <a href="/profile">去登录</a>'); return; }
      _favBusy = true;
      btn.disabled = true;
      setFav(!wasOn); // 乐观翻转:登录已确认 → 先本地翻到目标态,不等网络
      window.Auth.request(wasOn ? 'DELETE' : 'POST', '/api/favorites', { performance_id: perfId })
        .then(function (res) {
          if (res.ok && res.data) {
            var fav = !!res.data.favorited;
            _favReady = true; // 本会话已 toggle → _fav 权威,避免旧数据 favorited 兜底盖过取消操作
            setFav(fav); // 以服务端为准校正(与乐观不一致时服务端优先)
          }
          else if (res.status === 401) { setFav(wasOn); flashBtn(btn, 'fav-flash'); note('登录后可收藏 · <a href="/profile">去登录</a>'); } // 会话失效 → 回滚
          else if (res.status === 429) { setFav(wasOn); note('操作太频繁,稍后再试', 'err'); }
          else { setFav(wasOn); note('操作失败,请重试', 'err'); }
        })
        .catch(function () { setFav(wasOn); note('网络异常,请重试', 'err'); }) // 网络异常 → 回滚点击前态
        .then(function () { _favBusy = false; btn.disabled = false; });
    });
  }

  /** 弹窗点击委托(modal-body 上绑一次):reaction 按钮 .rt-btn / 收藏星标 .perf-fav。
   *  reaction:已选再点 = DELETE 取消;否则 POST 添加;按服务端返回重绘(不做乐观更新) */
  function handleBodyClick(e) {
    if (!e.target || !e.target.closest) return;
    var shareBtn = e.target.closest('.perf-share');
    if (shareBtn) {
      e.preventDefault();
      var perfId = shareBtn.getAttribute('data-perf-id');
      var targetItem = null;
      for (var ri = 0; ri < rendered.length; ri++) {
        if (rendered[ri].item.id === perfId) { targetItem = rendered[ri].item; break; }
      }
      if (targetItem) {
        var url = window.ShareUtils ? window.ShareUtils.buildPerformanceShareUrl(targetItem) : '';
        if (window.ShareUtils) {
          window.ShareUtils.copyWithFeedback(shareBtn, url, '演出链接已复制');
        }
        if (window.history && window.history.replaceState) {
          var u = new URL(location.href);
          u.searchParams.set('perf', perfId);
          history.replaceState(null, '', u.pathname + u.search);
        }
      }
      return;
    }
    var favBtn = e.target.closest('.perf-fav');
    if (favBtn) { if (window.Auth) { e.preventDefault(); handleFavClick(favBtn); } return; }
    var btn = e.target.closest('.rt-btn');
    if (!btn || !window.Auth) return;
    e.preventDefault();
    var bar = btn.closest('.perf-reactions');
    if (!bar) return;
    var perfId = bar.getAttribute('data-perf-id');
    var type = btn.getAttribute('data-type');
    if (!perfId || !type) return;

    // 检查登录态:未登录则立即提示登录,不进行假乐观更新
    var cached = (window.Auth.currentUser && window.Auth.currentUser()) || (window.Auth.cachedUser && window.Auth.cachedUser());
    if (!cached) {
      flashBtn(btn);
      reactNote(bar, '登录后可反应 · <a href="/profile">去登录</a>');
      return;
    }

    var wasOn = btn.classList.contains('on');
    var nextOn = !wasOn;
    var numEl = btn.querySelector('.rt-n');
    var prevCount = parseInt(numEl ? numEl.textContent : '0', 10) || 0;
    var nextCount = nextOn ? (prevCount + 1) : Math.max(0, prevCount - 1);

    // 乐观立即变动:前端先直接变，增加弹跳微动效，不等网络返回
    btn.classList.toggle('on', nextOn);
    if (numEl) numEl.textContent = nextCount;
    btn.classList.remove('rt-pop');
    void btn.offsetWidth; // 触发 reflow 重启动画
    btn.classList.add('rt-pop');

    // 同步更新本地会话缓存 _rxCache
    if (_rxCache[perfId]) {
      _rxCache[perfId].counts = _rxCache[perfId].counts || {};
      _rxCache[perfId].counts[type] = nextCount;
      var mineList = _rxCache[perfId].mine || [];
      if (nextOn) {
        if (mineList.indexOf(type) === -1) mineList.push(type);
      } else {
        mineList = mineList.filter(function (t) { return t !== type; });
      }
      _rxCache[perfId].mine = mineList;
    }

    // 后端异步同步处理
    window.Auth.request(wasOn ? 'DELETE' : 'POST', '/api/reactions', { performance_id: perfId, type: type })
      .then(function (res) {
        if (res.ok && res.data && res.data.reactions) {
          _rxCache[perfId] = res.data.reactions;
          renderReactions(bar, res.data.reactions);
        } else if (res.status === 401) {
          // 会话失效:回滚
          btn.classList.toggle('on', wasOn);
          if (numEl) numEl.textContent = prevCount;
          flashBtn(btn);
          reactNote(bar, '登录后可反应 · <a href="/profile">去登录</a>');
        } else if (res.status === 429) {
          btn.classList.toggle('on', wasOn);
          if (numEl) numEl.textContent = prevCount;
          reactNote(bar, '操作太频繁,稍后再试', 'err');
        } else {
          btn.classList.toggle('on', wasOn);
          if (numEl) numEl.textContent = prevCount;
          reactNote(bar, '操作失败,请重试', 'err');
        }
      })
      .catch(function () {
        // 网络异常:回滚
        btn.classList.toggle('on', wasOn);
        if (numEl) numEl.textContent = prevCount;
        reactNote(bar, '网络异常,请重试', 'err');
      });
  }

  // ---- 演出排序(2026-09-12) ----
  // 默认最新在前;该城市 ≥2 场时弹窗头部出现方向切换控件。
  // 每次 open() 复位成默认 —— 不做跨弹窗持久化,行为可预测,且控件就在手边。
  var sortDir = 1;      // 1 = 最新在前(默认);-1 = 最早在前
  var rendered = [];    // [{ item, el }] 当次渲染的 item↔节点对照,切换排序时只挪这些节点
  var SCROLL_INSET = 16; // 深链定位时目标卡距 #modal-body 顶部的留白(px)

  /** 排序键 —— **必须与卡片显示的时间同源**。卡片显示的是 `p.date`,date 不可用时才回退 `p.year`
   *  (见 buildPerf 的 `<time class="perf-date">`),所以排序也照这条规则取值:
   *    'YYYY-MM-DD' → 20250523;只有年份 '2009' → 20090000;缺失/畸形 → 退回 year;仍无 → -1 沉底。
   *
   *  **不能拿 p.year 当主键**(2026-09-12 初版就是这么错的,用户报「2001-01-07 排在 2001-05-27
   *  前面」):库里存在 year 与 date 不一致的记录 —— 北京「中华情」year=2004 但 date=2001-01-07,
   *  高雄跨年 year=2013 但 date=2012-12-31。按 year 排会把北京那条插进 2007 与 2001 之间,
   *  而卡片上印着 2001-01-07 —— 顺序与内容自相矛盾。列表按什么显示,就得按什么排。
   *
   *  也不能直接 localeCompare 原始串:空值字符串化成 ''/'null',其中 'null' 在字典序上排在
   *  '2015…' 之后 —— 倒序时会冒充"最新"窜到最前。空值必须沉底,不能靠字典序碰运气。 */
  function dateRank(p) {
    var d = String(p && p.date != null ? p.date : '').trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
    var y = /^(\d{4})$/.exec(d);
    if (y) return (+y[1]) * 10000;
    var fy = p ? Number(p.year) : NaN;   // date 不可用 → 与卡片显示同样的回退
    return (isFinite(fy) && fy >= 1000) ? fy * 10000 : -1;
  }

  /** 单一键排序 —— 键本身已含年份,不再单独比 `p.year`(那正是上面说的出问题的地方)。
   *  dir=1 新在前(默认)/ -1 旧在前,纯反向不设特例。 */
  function comparePerf(a, b, dir) {
    return dir * (dateRank(b) - dateRank(a));
  }
  function sortPerfs(list, dir) {
    return list.slice().sort(function (a, b) { return comparePerf(a, b, dir); });
  }

  /** 头部排序控件:两个**静态标签**的按钮 + aria-pressed。
   *  不用"单钮换标签":那样 pressed 没有稳定语义(标签本身在变),而且两个选项同时可见,
   *  当前处于哪种排序一眼可读。选中态沿用本站既有的"实底强调色"(.yearbar__reset / .mine-tab)。 */
  function renderSortControl(count) {
    var host = document.getElementById('modal-sort');
    if (!host) return;
    if (count < 2) { host.hidden = true; host.innerHTML = ''; return; }
    host.innerHTML = [{ d: 1, t: '最新在前' }, { d: -1, t: '最早在前' }].map(function (o) {
      return '<button type="button" class="sort-btn" data-dir="' + o.d + '" aria-pressed="' +
        (o.d === sortDir ? 'true' : 'false') + '">' + o.t + '</button>';
    }).join('');
    host.hidden = false;
    Array.prototype.forEach.call(host.querySelectorAll('.sort-btn'), function (b) {
      b.addEventListener('click', function () { applySort(+b.getAttribute('data-dir')); });
    });
  }
  function syncSortButtons() {
    var host = document.getElementById('modal-sort');
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('.sort-btn'), function (b) {
      b.setAttribute('aria-pressed', (+b.getAttribute('data-dir') === sortDir) ? 'true' : 'false');
    });
  }

  /** 切换排序:把**已有节点**按新顺序重新 append,不重建 DOM。
   *  重建会丢掉 reaction 计数、已懒填的封面与异步回填状态,还让整列闪一下;
   *  且直接落到最终态、不等过渡结束,连点不会错乱。 */
  function applySort(dir) {
    if (dir === sortDir) return;
    sortDir = dir;
    var body = document.getElementById('modal-body');
    if (!body || rendered.length < 2) return;
    var order = rendered.map(function (r) { return r.item; }); // 原始次序,兼作"item → 原下标"的索引表
    sortPerfs(order, dir).forEach(function (it) {
      var i = order.indexOf(it);          // 同一批对象引用,indexOf 可靠
      if (i !== -1) body.appendChild(rendered[i].el);
    });
    syncSortButtons();
  }

  /** 深链定位:把目标卡瞬时滚到 #modal-body 可视区顶部附近,并给它一次短暂描边反馈。
   *  **只写 #modal-body 的 scrollTop**(不用 scrollIntoView):本站 .modal-open 没有任何 CSS 规则,
   *  页面背后没被锁,scrollIntoView 会连带把背后的歌手页滚走,关掉弹窗后用户落在错位的页面。
   *  getBoundingClientRect 差值方案副作用为零。返回写入后的 scrollTop,供懒填复校时比对(防打扰闸)。 */
  function placeTarget(body, el, flash) {
    var top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - SCROLL_INSET;
    body.scrollTop = Math.max(0, top);   // 瞬时,不是平滑滚动(深链语义是「把我放到这里」)
    // flash 只在**首次**定位时为真:懒填后的复校只校正位置,不再重新加类。
    // 否则懒填慢于 1400ms(首次高亮已退场)时会在 2 秒后**再闪一次**——那读起来像页面在反复宣告同一件事,
    // 与 R5「淡出后回到常态」不符(2026-09-13 实测复校确实会闪第二段,故加此闸)。
    if (flash) {
      el.classList.add('is-target');
      // 高亮自行退场:计时器摘类。reduced-motion 下描边仍可见、只是不做淡出动画,同样由这里摘除。
      setTimeout(function () { el.classList.remove('is-target'); }, 1400);
    }
    return body.scrollTop;
  }

  function open(cityData, perfId) {
    var overlay = document.getElementById('modal');
    if (!overlay) return;

    document.getElementById('modal-city').textContent = cityData.city;
    document.getElementById('modal-meta').textContent = cityData.count + ' 场演出';

    sortDir = 1; // 每次打开复位默认
    var body = document.getElementById('modal-body');
    var items = sortPerfs(cityData.items, sortDir);
    body.innerHTML = items.map(buildPerf).join('');
    // 记录 item↔节点对照,供排序切换原地重排
    rendered = items.map(function (it, i) { return { item: it, el: body.children[i] }; });
    renderSortControl(items.length);
    // 反应条同步渲染(读缓存/空态)→ 与其它 UI 一起出现,不再等网络;缺失计数异步回填
    paintReactionBars();
    ensureCounts(items.map(function (i) { return i.id; }).filter(Boolean));
    // v10 懒填:无 cover_url 的白名单文字链接渐进换装封面(≤5 条,失败记会话 no-fill)。
    // 拿到 Promise 以便深链定位在封面换装(卡片高度变化)后复校。
    var lazyDone = lazyFillCovers(body);

    overlay.classList.add('open');
    // 修复 3:重置滚动位置。body 是复用同一个 #modal-body 容器,关闭时只是给 overlay 去 .open
    // (display:none),滚动位置会被保留 → 长 setlist 弹窗(默认展开后成为常态)重开会停在半空。
    // 必须在加 .open(display:block)之后置 0:display:none 时元素无滚动盒,赋值会被丢弃。
    body.scrollTop = 0;
    document.body.classList.add('modal-open');

    // 深链定位(可选第二参 perfId,仅收藏卡深链走这条;地图点击不传 = 行为逐字不变)。
    // 用 rendered 对照表查目标节点,**不拼 querySelector**:[data-perf-id] 在 .perf/.perf-fav/
    // .perf-reactions 三个层级都存在,拼选择器易命中错的那个,还要处理引号转义。
    // 只在 open 时定位一次;切排序不跟随(D4:跟随会让高亮在用户操作后乱跳)。
    if (perfId) {
      if (window.history && window.history.replaceState) {
        var u = new URL(location.href);
        u.searchParams.set('perf', perfId);
        history.replaceState(null, '', u.pathname + u.search);
      }
      var hit = null;
      for (var hi = 0; hi < rendered.length; hi++) {
        if (rendered[hi].item.id === perfId) { hit = rendered[hi].el; break; }
      }
      if (hit) {
        var placedTop = placeTarget(body, hit, true);
        // 懒填换装封面会改卡片高度,使已滚到位的目标漂移 → 排空后复校一次(只校正位置,不重新高亮)。
        // 防打扰闸:仅当 body.scrollTop 仍是我们写入的值(用户没自己滚过)才复校。
        lazyDone.then(function () {
          if (body.scrollTop === placedTop) placeTarget(body, hit, false);
        });
      }
    }
    // 不把焦点自动放到关闭按钮:否则 X 会出现选中环(Esc 仍可关,遮罩点击也可关)
  }

  function close() {
    var overlay = document.getElementById('modal');
    if (overlay) overlay.classList.remove('open');
    document.body.classList.remove('modal-open');
    if (window.history && window.history.replaceState) {
      var u = new URL(location.href);
      if (u.searchParams.has('perf')) {
        u.searchParams.delete('perf');
        var qs = u.searchParams.toString();
        history.replaceState(null, '', qs ? u.pathname + '?' + qs : u.pathname);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var overlay = document.getElementById('modal');
    if (!overlay) return;
    document.getElementById('modal-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.classList.contains('modal-backdrop')) close();
    });
    var bodyEl = document.getElementById('modal-body');
    if (bodyEl) bodyEl.addEventListener('click', handleBodyClick);
    // v10 封面图加载失败(图床 404/防盗链/大陆不可达 YT)→ .perf-cover 加 .is-broken,灰占位仍可点(不裂红)。
    // img 的 error 事件不冒泡,但在捕获阶段可达祖先 → capture=true。
    if (bodyEl) bodyEl.addEventListener('error', function (e) {
      var t = e.target;
      if (t && t.tagName === 'IMG' && t.classList && t.classList.contains('perf-cover__img')) {
        var cover = t.closest('.perf-cover');
        if (cover) cover.classList.add('is-broken');
      }
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
  });

  root.Modal = {
    open: open,
    close: close,
    prefetchReactions: prefetchReactions,
    prefetchFavorites: prefetchFavorites,
  };
})(typeof window !== 'undefined' ? window : globalThis);
