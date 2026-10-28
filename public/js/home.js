/* home.js —— 首页(S4c 结构重做)
 *
 * 数据:/api/singers(歌手 + 场次/城市计数)+ /api/performances(年份聚合,接口已存在,不改后端)。
 * 结构:档案头版(performance_count 最高的歌手 + 年份跨度条)+ 紧凑歌手目录行 + 「请求新增歌手」文字动作。
 *
 * 设计依据:design-proposal.md §2.1 提案 A —— 首页从「等权卡片网格」改为「档案头版 + 目录」。
 *  - 头版年份条复用 /js/yearbar.js 的 window.YearBar(与歌手页同一份组件,不复制第二套);
 *    首页年份条是**导航入口**:点击某年 → 跳转 /singer/{id}?year=YYYY。
 *    门槛:头版歌手演出 < MASTHEAD_YEARBAR_MIN(10)场不画条(首页概览面,见该常量注释)。
 *  - 次要歌手降级为目录行:姓名 · 英文名 · 场次 · 城市数(如「1 场 · 1 城」);
 *    0 场显示「暂无收录 · 可提交」并指向提交页。
 *  - 「请求新增歌手」不再是虚线占位卡,降级为目录末尾的文字动作。
 */

(function () {
  'use strict';

  var prefetchedSingers = {};
  function prefetchSinger(id) {
    if (!id || prefetchedSingers[id]) return;
    prefetchedSingers[id] = true;
    fetch('/api/performances?singer=' + encodeURIComponent(id)).catch(function () {});
    fetch('/api/tags?singer=' + encodeURIComponent(id)).catch(function () {});
    fetch('/api/singer-intros?singer=' + encodeURIComponent(id)).catch(function () {});
  }

  // 本页有 reveal 主脚本:门控归这里管,由 /js/boot.js 读取(见该文件注释)
  window.__appBooted = true;

  // 大头照缓存版本:统一走 Auth.avatarSrc(站内头像路径自动追加版本号)
  var avatarSrc = Auth.avatarSrc;

  /** 首字占位(portrait 为空 / 加载失败):中文取首字,装饰性 → aria-hidden。 */
  function avatarFallback(className, name) {
    var fb = document.createElement('div');
    fb.className = className + ' ' + className + '--fallback';
    fb.setAttribute('aria-hidden', 'true');
    fb.textContent = (name || '?').slice(0, 1);
    return fb;
  }

  /** 歌手头像(头版大图 / 目录小图共用):有 portrait → img(带版本号);否则首字占位。
   *  加载失败(404 / 防盗链 / 跨域)→ 就地换成首字占位,不出现裂图。 */
  function buildAvatar(s, className, eager) {
    var name = s.name_zh || s.name_en || s.id || '?';
    if (!s.portrait) return avatarFallback(className, name);
    var img = document.createElement('img');
    img.className = className;
    img.src = avatarSrc(s.portrait);
    img.alt = name;
    img.loading = eager ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.replaceChild(avatarFallback(className, name), img);
    });
    return img;
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (window.Auth) Auth.renderAuthLink(document.getElementById('auth-link'));

    var content = document.getElementById('home-content');
    if (!content) return;
    var masthead = document.getElementById('home-masthead');
    var directory = document.getElementById('home-directory');

    /* 数据就绪后:头版 + 目录 + footer 一起淡入(与既有一致的门控行为) */
    function reveal() {
      var loading = document.getElementById('home-loading');
      if (loading) loading.remove();
      content.classList.add('is-ready');
      var foot = document.getElementById('site-foot');
      if (foot) foot.classList.add('is-ready');
      window.__appReady = true;
    }

    /** 场次降序;数组稳定排序保留接口 sort_order 次序作为同场次内的稳定序。
     *  (按 sort_order 排序是「编辑挑的顺序」,首页改用真实权重排序,0 场自然沉底) */
    function byCountDesc(list) {
      return list.slice().sort(function (a, b) {
        return (b.performance_count || 0) - (a.performance_count || 0);
      });
    }

    function countByYear(perfs) {
      var counts = {};
      perfs.forEach(function (p) {
        var y = Number(p.year);
        if (y) counts[y] = (counts[y] || 0) + 1;
      });
      return counts;
    }

    /** 年份标签目录(只用于**定轴范围**,与歌手页同源)。
     *  歌手页的轴 = 演出年份 ∪ 「年份」类别下的全部标签(含 0 场但有标签的年份,如 2026);
     *  首页若只按演出年份取轴,同一歌手的刻度会比歌手页少一年 —— 从首页点年份跳过去后,
     *  落地页刻度会「变长一年」。故首页额外取一次 /api/tags?singer={头版歌手},拿同一份目录。
     *  **场次计数仍来自 /api/performances**,这次请求只用来定轴的范围。
     *  失败 / 非 200 / 无该类别 → 返回 [] 优雅降级(退回按演出年份取轴),不拖垮首页其余渲染。 */
    function fetchYearTagYears(singerId) {
      return fetch('/api/tags?singer=' + encodeURIComponent(singerId))
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (catalog) {
          var cats = (catalog && catalog.categories) || [];
          var years = [];
          cats.forEach(function (c) {
            if (c.name !== '年份') return;
            (c.tags || []).forEach(function (t) {
              var n = Number(t.name);
              if (n >= 1900 && n <= 2100) years.push(n);
            });
          });
          return years;
        })
        .catch(function () { return []; });
    }

    /** 完整刻度 = 演出年份 ∪ 年份标签目录 的 min..max(含中间 0 场年份,让稀疏一眼可见)。
     *  tagYears 缺省时退化为「仅演出年份」——即修复前的行为;降级路径与旧调用都不受破坏。 */
    function yearSpan(counts, tagYears) {
      var ys = Object.keys(counts).map(Number).filter(function (y) { return y >= 1900 && y <= 2100; });
      (tagYears || []).forEach(function (y) {
        if (y >= 1900 && y <= 2100) ys.push(y);
      });
      if (!ys.length) return null;
      var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), out = [];
      for (var y = lo; y <= hi; y++) out.push(y);
      return out;
    }

    /** 首页头版年份条的**产品门槛**(用户指定,2026-09-11):演出不足 10 场的头版歌手不画年份条。
     *  首页是**概览面** —— 只给场次足够多的歌手展示年份分布,目录行保持紧凑;
     *  歌手页是**详情面** —— 判据不同(仅「总演出为 0」不画),有数据就画完整轴。
     *  两处门槛不同是有意的,勿为「统一」而合并。 */
    var MASTHEAD_YEARBAR_MIN = 10;

    /** 头版年份条:复用 window.YearBar;点击年份 = 跳转歌手页按年筛选(非本地筛选)。
     *  tagYears 决定轴的**范围**(与歌手页同源,见 fetchYearTagYears);counts 仍是真实场次。
     *  不画条(轴为空,或未达 MASTHEAD_YEARBAR_MIN 门槛)时仍把摘要写进 host,
     *  避免头版信息降级为空 —— 与歌手页 updateYearBar 的 `if (!yearBar) el.textContent = summary` 兜底一致。 */
    function mountYearBar(host, s, perfsOrCounts, tagYears) {
      var counts = s.year_counts || (Array.isArray(perfsOrCounts) ? countByYear(perfsOrCounts) : (perfsOrCounts || {}));
      var years = yearSpan(counts, tagYears);
      var summary = (s.performance_count || 0) + ' 场演出 · ' + (s.city_count || 0) + ' 个城市';
      if (!years || (s.performance_count || 0) < MASTHEAD_YEARBAR_MIN) {
        host.textContent = summary;
        return;
      }
      var active = new Set(years.filter(function (y) { return (counts[y] || 0) > 0; }));
      var bar = window.YearBar.create(host, {
        years: years,
        ariaLabel: s.name_zh + ' 演出年份,点击进入歌手页按年查看',
        onToggle: function (y) {
          location.href = '/singer/' + encodeURIComponent(s.id) + '?year=' + y;
        }
      });
      bar.update({
        counts: counts,
        selected: new Set(),
        activeYears: active,
        summary: summary
      });
    }

    var PIN_KEY = 'preferred_masthead_singer';
    function getPinnedSingerId() {
      try { return localStorage.getItem(PIN_KEY); } catch (e) { return null; }
    }
    function setPinnedSingerId(id) {
      try {
        if (id) localStorage.setItem(PIN_KEY, id);
        else localStorage.removeItem(PIN_KEY);
      } catch (e) {}
    }

    /** 歌手微简介跑马灯与快捷提交 */
    function mountMicroIntros(container, singer) {
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
      addBtn.title = '为 ' + singer.name_zh + ' 补充一句话简介';
      addBtn.setAttribute('aria-label', addBtn.title);
      addBtn.innerHTML = '<span class="intro-chip__plus">+</span> 补充一句';
      bar.appendChild(addBtn);

      container.appendChild(bar);

      function renderChips(intros) {
        track.innerHTML = '';
        var items = intros && intros.length ? intros : null;
        if (!items) {
          if (singer.intro) {
            var offChip = document.createElement('div');
            offChip.className = 'intro-chip intro-chip--official';
            offChip.innerHTML = '<span class="intro-chip__text">' + Auth.esc(singer.intro) + '</span><span class="intro-chip__author">官方简介</span>';
            track.appendChild(offChip);
          }
          viewport.classList.add('no-mask');
          track.classList.remove('intros-track--marquee');
          return;
        }

        items.forEach(function (it) {
          var chip = document.createElement('div');
          chip.className = 'intro-chip';
          chip.innerHTML = '<span class="intro-chip__text">' + Auth.esc(it.content) + '</span>' +
            '<span class="intro-chip__author">by @' + Auth.esc(it.submitter_name || '歌友') + '</span>';
          track.appendChild(chip);
        });

        // 数量 > 3 时克隆列表实现无缝首尾相连循环跑马灯
        if (items.length > 3) {
          items.forEach(function (it) {
            var clone = document.createElement('div');
            clone.className = 'intro-chip';
            clone.setAttribute('aria-hidden', 'true');
            clone.innerHTML = '<span class="intro-chip__text">' + Auth.esc(it.content) + '</span>' +
              '<span class="intro-chip__author">by @' + Auth.esc(it.submitter_name || '歌友') + '</span>';
            track.appendChild(clone);
          });
          track.classList.add('intros-track--marquee');
          viewport.classList.remove('no-mask');
        } else {
          track.classList.remove('intros-track--marquee');
          viewport.classList.add('no-mask');
        }
      }

      fetch('/api/singer-intros?singer=' + encodeURIComponent(singer.id))
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
              title: '为 ' + singer.name_zh + ' 补充一句话简介',
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
              Auth.request('POST', '/api/singer-intros', { singer_id: singer.id, content: trimmed })
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

    /** 档案头版:大尺寸头像 + 姓名(--fs-3xl)/ 英文名 / 简介(intro 为空 → 整行不渲染)+ 年份条。
     *  头像与姓名左右并排(窄屏降一档尺寸,不堆叠,避免首屏多出一段竖向空白)。 */
    function buildMasthead(s, perfs, tagYears, isPinned, onPinChange) {
      masthead.innerHTML = '';
      if (!s) return;

      var hero = document.createElement('div');
      hero.className = 'masthead__hero';
      hero.appendChild(buildAvatar(s, 'masthead__avatar', true));

      var id = document.createElement('div');
      id.className = 'masthead__id';

      var head = document.createElement('div');
      head.className = 'masthead__head';

      var name = document.createElement('h2');
      name.className = 'masthead__name';
      var nameLink = document.createElement('a');
      nameLink.className = 'masthead__name-link';
      nameLink.href = '/singer/' + encodeURIComponent(s.id);
      nameLink.textContent = s.name_zh || s.name_en || s.id;
      nameLink.addEventListener('pointerenter', function () { prefetchSinger(s.id); }, { once: true });
      name.appendChild(nameLink);
      head.appendChild(name);

      if (window.Icons) {
        var pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'ghost-icon-btn masthead__pin-btn' + (isPinned ? ' is-pinned' : '');
        pinBtn.title = isPinned ? '已设为首页置顶（点击取消置顶，恢复默认按场次）' : '设为首页置顶歌手';
        pinBtn.setAttribute('aria-label', pinBtn.title);
        pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        pinBtn.innerHTML = isPinned ? Icons.get('pinFilled') : Icons.get('pin');
        pinBtn.addEventListener('click', function () {
          if (onPinChange) onPinChange(isPinned ? null : s.id);
        });
        head.appendChild(pinBtn);
      }

      if (s.name_en) {
        var en = document.createElement('p');
        en.className = 'masthead__en';
        en.textContent = s.name_en;
        head.appendChild(en);
      }
      id.appendChild(head);

      mountMicroIntros(id, s);
      hero.appendChild(id);
      masthead.appendChild(hero);

      if (window.YearBar) {
        var host = document.createElement('div');
        host.className = 'masthead__yearbar yearbar-host';
        masthead.appendChild(host);
        mountYearBar(host, s, perfs, tagYears);
      }
    }

    /** 目录行:小头像 + 姓名 · 英文名(链到歌手页)· 场次;0 场 → 「暂无收录 · 可提交」(链到提交页预选该歌手) */
    function buildRow(s, onPinChange) {
      var li = document.createElement('li');
      li.className = 'directory__row';
      li.id = 'singer-row-' + s.id;

      li.appendChild(buildAvatar(s, 'directory__row-avatar', false));

      var nameLink = document.createElement('a');
      nameLink.className = 'directory__row-name';
      nameLink.href = '/singer/' + encodeURIComponent(s.id);
      nameLink.addEventListener('pointerenter', function () { prefetchSinger(s.id); }, { once: true });

      var zh = document.createElement('span');
      zh.className = 'directory__row-zh';
      zh.textContent = s.name_zh || s.id;
      nameLink.appendChild(zh);

      if (s.name_en) {
        var en = document.createElement('span');
        en.className = 'directory__row-en';
        en.textContent = s.name_en;
        nameLink.appendChild(en);
      }
      li.appendChild(nameLink);

      var meta = document.createElement('span');
      meta.className = 'directory__row-meta';
      var n = s.performance_count || 0;
      if (n > 0) {
        meta.classList.add('directory__row-count');
        // 紧凑目录:场次 + 城市数(旧卡片版有城市数,S4c 降级时丢失,此处补回)。
        // 头版摘要是「48 场演出 · 37 个城市」,目录行用更短的「1 场 · 1 城」以免抢眼。
        var c = s.city_count || 0;
        meta.textContent = c > 0 ? (n + ' 场 · ' + c + ' 城') : (n + ' 场');
      } else {
        // 不把弱点放大成「0 场演出 · 0 个城市」;指向提交页可直接补录(?singer= 预选,见 submit.js)
        meta.appendChild(document.createTextNode('暂无收录 · '));
        var sub = document.createElement('a');
        sub.className = 'directory__row-submit';
        sub.href = '/submit?singer=' + encodeURIComponent(s.id);
        sub.textContent = '可提交';
        // 独立链接的可见文字只有「可提交」,读屏用户无从知道为哪个歌手提交 → 补可访问名
        sub.setAttribute('aria-label', '为' + (s.name_zh || s.name_en || s.id) + '提交演出');
        meta.appendChild(sub);
      }
      li.appendChild(meta);

      if (window.Icons) {
        var pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'ghost-icon-btn directory__pin-btn';
        pinBtn.title = '置顶到首页头版';
        pinBtn.setAttribute('aria-label', '将' + (s.name_zh || s.name_en || s.id) + '置顶到首页头版');
        pinBtn.innerHTML = Icons.get('pin');
        pinBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (onPinChange) onPinChange(s.id);
        });
        li.appendChild(pinBtn);
      }

      return li;
    }

    function buildRequestAction() {
      var req = document.createElement('button');
      req.type = 'button';
      req.className = 'directory__request';
      req.setAttribute('aria-label', '请求新增歌手');
      req.textContent = '请求新增歌手';
      req.addEventListener('click', function () {
        if (window.SingerRequest) SingerRequest.open();
      });
      return req;
    }

    /** 目录:次要歌手(除头版外)按场次降序;末尾保留「请求新增歌手」文字动作 */
    function buildDirectory(others, onPinChange) {
      directory.innerHTML = '';
      if (others.length) {
        var title = document.createElement('h2');
        title.className = 'directory__title';
        title.textContent = '其他歌手';
        directory.appendChild(title);

        var ul = document.createElement('ul');
        ul.className = 'directory__list';
        others.forEach(function (s) { ul.appendChild(buildRow(s, onPinChange)); });
        directory.appendChild(ul);
      }
      directory.appendChild(buildRequestAction());
    }

    function animateCount(el, target, duration) {
      if (!el) return;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = Number(target || 0).toLocaleString('en-US');
        return;
      }
      var start = (window.performance && performance.now) ? performance.now() : Date.now();
      function tick(now) {
        var progress = Math.min((now - start) / (duration || 1400), 1);
        var ease = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        var val = Math.floor(ease * target);
        el.textContent = val.toLocaleString('en-US');
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = Number(target || 0).toLocaleString('en-US');
      }
      requestAnimationFrame(tick);
    }

    function renderHeroStats(singers, contribData) {
      var heroStats = document.getElementById('hero-stats');
      var countEl = document.getElementById('hero-live-count');
      var singersEl = document.getElementById('hero-top-singers');
      var contribsEl = document.getElementById('hero-top-contributors');
      if (!heroStats || !countEl || !singersEl || !contribsEl) return;

      var total = (contribData && contribData.total_performances) || 0;
      if (!total && singers && singers.length) {
        total = singers.reduce(function (sum, s) { return sum + (Number(s.performance_count) || 0); }, 0);
      }

      // 1. 现场总场次递增动效
      animateCount(countEl, total, 1400);

      // 2. Top 5 歌手微缩头像
      singersEl.innerHTML = '';
      var topSingers = byCountDesc(singers).slice(0, 5);
      topSingers.forEach(function (s) {
        var imgOrFb = buildAvatar(s, 'hero-stats__avatar', true);
        var name = s.name_zh || s.name_en || s.id;
        var count = s.performance_count || 0;
        imgOrFb.title = name + ': ' + count + ' 场演出';
        imgOrFb.setAttribute('aria-label', name + '，收录 ' + count + ' 场');
        imgOrFb.addEventListener('click', function (e) {
          e.stopPropagation();
          var targetEl = document.getElementById('singer-row-' + s.id) || document.getElementById('home-masthead');
          if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        singersEl.appendChild(imgOrFb);
      });
      singersEl.addEventListener('click', function () {
        var dir = document.getElementById('home-directory') || document.getElementById('home-masthead');
        if (dir) dir.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      // 3. Top 5 贡献者头像 (优先上传图，次选 6 款内置矢量 SVG，绝不显示字母)
      contribsEl.innerHTML = '';
      var topContribs = ((contribData && contribData.contributors) || []).slice(0, 5);
      topContribs.forEach(function (c) {
        var info = (window.Avatars && Avatars.resolve)
          ? Avatars.resolve(c.avatar_url, c.user_id)
          : { kind: 'default', key: 'ball' };
        var el;
        if (info.kind === 'upload') {
          el = document.createElement('img');
          el.className = 'hero-stats__avatar';
          el.src = (window.Auth && Auth.avatarSrc) ? Auth.avatarSrc(info.src) : info.src;
          el.alt = c.name;
          el.loading = 'lazy';
          el.addEventListener('error', function () {
            var fb = document.createElement('span');
            var fbKey = (window.Avatars && Avatars.defaultKeyFor) ? Avatars.defaultKeyFor(c.user_id) : 'mic';
            fb.className = 'hero-stats__avatar hero-stats__avatar--svg';
            fb.innerHTML = (window.Avatars && Avatars.svg) ? Avatars.svg(fbKey) : '';
            if (el.parentNode) el.parentNode.replaceChild(fb, el);
          });
        } else {
          el = document.createElement('span');
          el.className = 'hero-stats__avatar hero-stats__avatar--svg';
          el.innerHTML = (window.Avatars && Avatars.svg) ? Avatars.svg(info.key) : '';
        }
        var count = c.count || 0;
        el.title = c.name + ': 贡献 ' + count + ' 场';
        el.setAttribute('aria-label', c.name + '，贡献 ' + count + ' 场');
        contribsEl.appendChild(el);
      });
      contribsEl.removeAttribute('role');
      contribsEl.title = '核心贡献者';

      heroStats.hidden = false;
    }

    // 并行拉取贡献者数据 (用于 Hero 统计栏与底部星图)
    var contribPromise = fetch('/api/contributors')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { return { total_performances: 0, contributors: [] }; });

    // 优化:首页仅需拉取 /api/singers(内含聚合的 year_counts),彻底免去全量 120KB+ /api/performances
    fetch('/api/singers').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (singers) {
      singers = singers || [];

      // 绑定 Live Counter (星图暂隐藏)
      contribPromise.then(function (cData) {
        renderHeroStats(singers, cData);
        var constSec = document.getElementById('home-constellation');
        if (constSec) {
          constSec.hidden = true;
          constSec.style.display = 'none';
        }
      });

      if (!singers.length) {
        masthead.innerHTML = '';
        directory.innerHTML = '';
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = '暂无歌手,快来请求新增第一位歌手吧。';
        directory.appendChild(empty);
        directory.appendChild(buildRequestAction());
        reveal();
        return;
      }

      function render(tagYears) {
        var sorted = byCountDesc(singers);
        var pinnedId = getPinnedSingerId();
        var top = null;
        var isPinned = false;
        if (pinnedId) {
          top = singers.filter(function (s) { return s.id === pinnedId; })[0];
          if (top) isPinned = true;
        }
        if (!top) {
          top = sorted[0];
          isPinned = false;
        }
        var others = singers.filter(function (s) { return s.id !== top.id; });
        others = byCountDesc(others);

        buildMasthead(top, top.year_counts || {}, tagYears, isPinned, function (newPinnedId) {
          setPinnedSingerId(newPinnedId);
          render(null);
          refreshTagYears(newPinnedId);
        });
        buildDirectory(others, function (newPinnedId) {
          setPinnedSingerId(newPinnedId);
          render(null);
          refreshTagYears(newPinnedId);
        });
        reveal();
      }

      function refreshTagYears(singerId) {
        if (!singerId) return;
        fetchYearTagYears(singerId).then(function (tagYears) {
          if (tagYears && tagYears.length) {
            var host = masthead.querySelector('.masthead__yearbar');
            var topSinger = singers.filter(function (s) { return s.id === singerId; })[0];
            if (host && topSinger) {
              host.innerHTML = '';
              mountYearBar(host, topSinger, topSinger.year_counts || {}, tagYears);
            }
          }
        });
      }

      // 阶段 1: 立即使用 /api/singers 自带数据渲染首屏并解除遮罩，耗时仅 ~150-300ms！
      render(null);

      // 把全量歌手快照存入 sessionStorage，方便进入歌手页时 0ms 瞬间显示歌手标题与头像
      try { sessionStorage.setItem('all_singers', JSON.stringify(singers)); } catch (e) {}

      // 阶段 2: 异步补充轴范围标签(补全 0 场年份刻度),绝不拖慢首屏展现
      var sortedInit = byCountDesc(singers);
      var pinnedIdInit = getPinnedSingerId();
      var topIdInit = (pinnedIdInit && singers.some(function (s) { return s.id === pinnedIdInit; })) ? pinnedIdInit : (sortedInit[0] && sortedInit[0].id);
      if (topIdInit) refreshTagYears(topIdInit);

      // 阶段 3: 后台智能预加载 —— 自动在闲时预热最有可能点击的歌手页面具体数据（头版歌手 + 前 2 位其他歌手）
      var preloadCandidates = [];
      if (topIdInit) preloadCandidates.push(topIdInit);
      sortedInit.forEach(function (s) {
        if (s.id !== topIdInit && preloadCandidates.length < 3) preloadCandidates.push(s.id);
      });

      var doBackgroundPreload = function () {
        // 1) 优先预载头版歌手具体信息(演出/标签/微简介)
        preloadCandidates.forEach(function (sid) { prefetchSinger(sid); });
        // 2) 预拉取地图 SVG 底图(1MB)
        fetch('/images/world.svg').catch(function () {});
      };

      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(doBackgroundPreload);
      } else {
        setTimeout(doBackgroundPreload, 600);
      }
    }).catch(function () {
      masthead.innerHTML = '';
      directory.innerHTML = '<p class="empty">数据加载失败,请稍后刷新。</p>';
      reveal();
    });
  });
})();
