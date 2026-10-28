/* src/video-meta.js —— GET /api/video-meta?url= 视频结构化 meta 代理(公开 + 限流)
 *
 * 提交页「视频链接(最多 10 条)」区填好 YouTube/bilibili 链接后点「解析」,前端对每条
 * 链接调本端点取结构化 meta(video_id/title/cover_url/author_name),供自动预填标题/歌手/
 * 年份/城市/曲目使用。浏览器被 CSP connect-src 'self' 拦住,故走 Worker 代理(镜像
 * cities.js handleGeocode 范式:UA 头 + 手写 AbortController + 5s 超时 + 任何上游失败
 * 降级 {ok:false},绝不 500)。
 *
 * v10(video-covers):bilibili 通道切「view API」(`x/web-interface/view?bvid=`)一次 JSON
 * 拿 data.pic(封图,http→https 规整)+ data.title;失败回退现 HTML <title> 通道(有 title 无
 * cover,cover_url='')。YouTube cover = oembed thumbnail_url 或确定性
 * `https://i.ytimg.com/vi/<video_id>/hqdefault.jpg`。成功 return 前 UPSERT video_meta(写穿
 * 缓存:视频级 (provider,video_id) 键,封面/标题随演出数据下发,不做读时现抓)。
 *
 * v10-video_meta 查库兜底(2026-09-09):每次请求先按 parseVideo(与读路径同源键派生)查自身
 * video_meta 缓存——命中且 title 非空 → 直接 {ok:true} 回 title/封面,零上游调用;miss /
 * b23 解析不出 → 走既有在线分支。bilibili 从 CF 出口被 412 封后,缓存命中是「已收录过的
 * 视频裸链接」拿回标题/封面的唯一可靠通道(全新视频仍需收录/后台补齐后才可回)。
 *
 * 契约:成功 → {ok:true, provider:'youtube'|'bilibili', meta:{video_id,title,cover_url,author_name}}
 *       任何上游失败/超时/解析不到 title → 200 {ok:false};cover 取不到 → cover_url:''(不算失败)
 *       校验失败(url 空/非 http(s)/>2048/host 非白名单)→ 400;超限流 → 429
 *       占位/解析不出 video_id 的 URL → 不写 video_meta
 */

import { json, HttpError, checkRateLimit, clientIP } from './db.js';
import { providerOf, youtubeVideoId, biliVideoId, normalizeBilibiliUrl, parseVideo } from './video-id.js';

const UA = 'davidtao-archive/1.0 (map-concerts.com)';
// bilibili 对数据中心出口 WAF 较严:浏览器 UA + Referer 更贴近真实访问,降低 -412/403
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const META_TIMEOUT_MS = 5000;
const BILI_TIMEOUT_MS = 8000; // bilibili WAF 偶发慢;单次放宽并配合下方重试
const MAX_READ_BYTES = 300 * 1024; // bilibili 页只读前 ~300KB(足够含 <head><title>,防整页过大)

/** 分块拼接响应 body 前 maxBytes 字节(不用 text() 拉整页) */
async function readUpTo(res, maxBytes) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      text += decoder.decode(value, { stream: true });
      total += value.length;
      if (total >= maxBytes) break;
    }
  }
  try { await reader.cancel(); } catch (e) { /* ignore */ }
  return text;
}

/** 取 HTML <title> 首段 + 简单解码实体 */
function extractHtmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch (e) { return ''; } })
    .trim();
}

/** 去 bilibili 站点尾缀(「…_哔哩哔哩_bilibili」等),保留其余原文给前端解析 */
function cleanBiliTitle(title) {
  const i = title.indexOf('_哔哩哔哩');
  if (i !== -1) return title.slice(0, i).trim();
  const j = title.indexOf('_bilibili');
  if (j !== -1) return title.slice(0, j).trim();
  return title.trim();
}

async function fetchYouTubeMeta(rawUrl) {
  const endpoint = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(rawUrl) + '&format=json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { headers: { 'User-Agent': UA }, signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.title) return null;
    const video_id = youtubeVideoId(rawUrl);
    // cover:优先 oembed thumbnail_url,缺则确定性构造(i.ytimg.com 图床大陆不可达 → 前端 onerror 灰占位仍可点)
    let cover = '';
    const th = data.thumbnail_url;
    if (typeof th === 'string' && th) cover = th;
    else if (video_id) cover = 'https://i.ytimg.com/vi/' + video_id + '/hqdefault.jpg';
    return {
      video_id,
      title: String(data.title).trim(),
      author_name: data.author_name ? String(data.author_name).trim() : null,
      cover_url: cover,
    };
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 取 bilibili buvid cookie(`x/frontend/finger/spi` 指纹端,返回 b_3/b_4):
 *  数据中心/海外出口的 412 常因「缺 buvid」;带 cookie 再请求可能放行。失败返回 ''。 */
async function bilibiliBuvidCookie(debug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BILI_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json, text/plain, */*',
      },
      signal: controller.signal,
    });
    if (!res.ok) { if (debug) debug.spiStatus = res.status; return ''; }
    const data = await res.json();
    const b3 = data && data.data && data.data.b_3;
    const b4 = data && data.data && data.data.b_4;
    if (!b3) { if (debug) debug.spiFail = 'no-b3'; return ''; }
    if (debug) debug.spiOk = true;
    return 'buvid3=' + b3 + (b4 ? '; buvid4=' + b4 : '');
  } catch (err) {
    if (debug) debug.spiErr = (err && err.message) || String(err);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** bilibili view API:`x/web-interface/view?bvid=` 一次 JSON 拿 data.pic + data.title。
 *  浏览器 UA + Referer;首败(非 2xx / code!=0 / 无 title)时取一次 buvid cookie 再试(412 常因缺 cookie);
 *  debug=1 时把失败原因写回 debug。最多 2 次 view + 1 次 spi。 */
async function fetchBilibiliViewApi(bvid, debug) {
  const endpoint = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid);
  let cookie = '';
  let bootstrapped = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = {
      'User-Agent': BROWSER_UA,
      'Referer': 'https://www.bilibili.com/',
      'Accept': 'application/json, text/plain, */*',
    };
    if (cookie) headers['Cookie'] = cookie;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BILI_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, { headers, signal: controller.signal });
      if (!res.ok) {
        if (debug) { debug.viewApiStatus = res.status; debug.viewApiAttempt = attempt + 1; }
        if (!bootstrapped) {
          bootstrapped = true;
          cookie = await bilibiliBuvidCookie(debug);
          if (debug) debug.cookieGot = !!cookie;
          continue;
        }
        return null;
      }
      const data = await res.json();
      if (!data || data.code !== 0 || !data.data) {
        if (debug) debug.viewApiCode = data && data.code;
        if (!bootstrapped) {
          bootstrapped = true;
          cookie = await bilibiliBuvidCookie(debug);
          if (debug) debug.cookieGot = !!cookie;
          continue;
        }
        return null;
      }
      const title = cleanBiliTitle(String(data.data.title || '').trim());
      if (!title) { if (debug) debug.viewApiCode = 'no-title'; return null; }
      let cover = '';
      const pic = data.data.pic;
      if (typeof pic === 'string' && pic) cover = pic.replace(/^http:\/\//i, 'https://');
      return { video_id: bvid, title, author_name: null, cover_url: cover };
    } catch (err) {
      if (debug) debug.viewApiErr = (err && err.message) || String(err);
      if (!bootstrapped) {
        bootstrapped = true;
        cookie = await bilibiliBuvidCookie(debug);
        if (debug) debug.cookieGot = !!cookie;
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** bilibili HTML <title> 回退通道(redirect follow,b23 短链在此解析出真实 BV)。无 cover,cover_url=''。
 *  浏览器 UA + Referer(海外出口直接抓 www 常 412,仍保留为 av/b23 解析 canonical BV 的通道)。 */
async function fetchBilibiliHtml(rawUrl, debug) {
  const target = normalizeBilibiliUrl(rawUrl);
  const headers = { 'User-Agent': BROWSER_UA, 'Referer': 'https://www.bilibili.com/' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BILI_TIMEOUT_MS);
  try {
    const res = await fetch(target, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok) { if (debug) debug.htmlStatus = res.status; return null; }
    // b23.tv 短链会 302 → canonical BV 页;redirect 后 res.url 含真实 BV,优先从它取
    const finalUrl = res.url || target;
    const html = await readUpTo(res, MAX_READ_BYTES);
    const title = cleanBiliTitle(extractHtmlTitle(html));
    if (!title) { if (debug) debug.htmlReason = 'no-title'; return null; }
    return { video_id: biliVideoId(finalUrl) || biliVideoId(rawUrl), title, author_name: null, cover_url: '' };
  } catch (err) {
    if (debug) debug.htmlErr = (err && err.message) || String(err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** bilibili meta 主流程。
 *  - 直链 BV → view API(成功即返回);失败回退 HTML。
 *  - av 输入:view API 不认 bvid=av → 走 HTML redirect 解析出 canonical BV 后补一发 view API 拿封面,
 *    但返回/落库的 video_id 保持 av(与读路径 parseVideo 对 av 的解析一致,读附件才能命中)。
 *  - b23 短链:无 direct id → HTML redirect 解析出真实 BV,补一发 view API 拿封面,落库用 BV。 */
async function fetchBilibiliMeta(rawUrl, debug) {
  const direct = biliVideoId(rawUrl);
  const directIsBV = /^BV/i.test(direct);
  if (directIsBV) {
    const viaView = await fetchBilibiliViewApi(direct, debug);
    if (viaView) return viaView;
  }
  const html = await fetchBilibiliHtml(rawUrl, debug);
  if (!html) return null;
  const ident = direct || html.video_id; // av 输入保持 av(读路径自洽);b23 无 direct → 用 redirect 解析出的 BV
  if (html.video_id && !directIsBV) {
    // av/b23:HTML redirect 才拿到 canonical BV → 补一发 view API,尽量带回封面
    const viaView = await fetchBilibiliViewApi(html.video_id, debug);
    if (viaView) { viaView.video_id = ident; return viaView; }
  }
  return { video_id: ident, title: html.title, author_name: null, cover_url: '' };
}

/** 写穿缓存:成功解析到视频级 meta → UPSERT video_meta(幂等;占位/无 video_id 不写)。
 *  cover 取不到('')时保留旧值 —— 封面是稳定属性,避免一次回退通道清掉此前已入库的好封面。 */
async function upsertVideoMeta(env, provider, videoId, title, coverUrl) {
  if (!provider || !videoId) return;
  try {
    await env.DB.prepare(
      `INSERT INTO video_meta (provider, video_id, title, cover_url, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(provider, video_id) DO UPDATE SET
         title = excluded.title,
         cover_url = CASE WHEN excluded.cover_url = '' THEN video_meta.cover_url ELSE excluded.cover_url END,
         updated_at = excluded.updated_at`
    ).bind(provider, videoId, title || '', coverUrl || '').run();
  } catch (err) {
    // 写穿失败不影响主响应(限流/网络等边缘情况;下一轮命中会再补写)
    console.error('upsertVideoMeta failed:', err && err.message || err);
  }
}

/** GET /api/video-meta?url=
 *  - url 缺/trim 空 / 非 ^https?:// / 总长 >2048 → 400
 *  - host 非白名单 → 400「仅支持 YouTube / bilibili 视频链接」
 *  - 同 IP 60s 内 >20 次 → 429(checkRateLimit 抛)
 *  - 上游任何失败/超时/非 2xx/解析不到 title → 200 {ok:false}(绝不 500)
 *  - 成功 → {ok:true, provider, meta:{video_id, title, cover_url, author_name}} */
export async function handleVideoMeta(request, env, url) {
  const raw = (url.searchParams.get('url') || '').trim();
  if (!raw) throw new HttpError(400, '缺少链接');
  if (!/^https?:\/\//i.test(raw)) throw new HttpError(400, '链接需以 http(s):// 开头');
  if (raw.length > 2048) throw new HttpError(400, '链接过长');
  try { new URL(raw); } catch (e) { throw new HttpError(400, '链接无效'); }
  const provider = providerOf(raw);
  if (!provider) throw new HttpError(400, '仅支持 油管 / B站 视频链接');

  await checkRateLimit(env, clientIP(request), 'video_meta', 60, 20);

  // ?debug=1 → 失败时把诊断原因(HTTP status / code / err)带出,便于定位 CF→bilibili 上游问题;不影响正常契约
  const wantDebug = url.searchParams.get('debug') === '1';
  const debug = wantDebug ? {} : null;

  // v10-video_meta 查库兜底(2026-09-09):两平台都先按读路径同源键派生(parseVideo,av 小写)查
  // 自己的 video_meta 缓存——已收录/已解析过的视频裸链接直接带出 title+封面,不再现抓上游
  // (bilibili 从 CF 出口被 412 封,缓存命中是「已知视频」零网络拿标题封面的唯一可靠通道)。
  // miss / 解析不出(b23 短链等)→ 走既有在线分支,契约与 upsert 不变。
  const pv = parseVideo(raw);
  if (pv) {
    const cached = await env.DB.prepare(
      'SELECT title, cover_url FROM video_meta WHERE provider = ? AND video_id = ?'
    ).bind(pv.provider, pv.video_id).first();
    if (cached && cached.title) {
      return json({
        ok: true,
        provider: pv.provider,
        meta: { video_id: pv.video_id, title: cached.title, cover_url: cached.cover_url || '', author_name: null },
      });
    }
  }

  if (provider === 'youtube') {
    const meta = await fetchYouTubeMeta(raw);
    if (!meta) return json(wantDebug ? { ok: false, debug } : { ok: false });
    await upsertVideoMeta(env, 'youtube', meta.video_id, meta.title, meta.cover_url);
    return json({ ok: true, provider: 'youtube', meta });
  }
  const meta = await fetchBilibiliMeta(raw, debug);
  if (!meta) return json(wantDebug ? { ok: false, debug } : { ok: false });
  await upsertVideoMeta(env, 'bilibili', meta.video_id, meta.title, meta.cover_url);
  return json({ ok: true, provider: 'bilibili', meta });
}

/**
 * GET /api/video-meta/missing
 * 
 * 极简高效差集查询端点：
 * 筛选全站（或指定近期范围/歌手）所有已审核且未删除演出中缺少封面（cover_url 为空或未入库）的 B 站链接。
 * 
 * 参数：
 *   - recent: 可选正整数，例如 recent=30，只检索最近审核/创建的 N 场演出
 *   - singer: 可选歌手 ID
 */
export async function handleMissingVideoMeta(request, env, url) {
  if (request.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405);
  }

  const q = url.searchParams;
  const singer = q.get('singer');
  const recentStr = q.get('recent');
  const recent = (recentStr && /^\d+$/.test(recentStr)) ? Math.max(1, Math.min(1000, Number(recentStr))) : 0;
  const wantAll = q.get('all') === '1';

  let links = [];

  if (recent > 0) {
    // 1. 最近 N 场模式：先按 COALESCE(reviewed_at, created_at) 取最近 N 场演出 ID
    const pConds = ["p.status = 'approved'", 'p.is_deleted = 0'];
    const pArgs = [];
    if (singer) {
      pConds.push('p.singer = ?');
      pArgs.push(singer);
    }
    pArgs.push(recent);

    const { results: recentPerfs } = await env.DB.prepare(
      `SELECT p.id, p.title, p.singer, COALESCE(p.reviewed_at, p.created_at) AS active_time
       FROM performances p
       WHERE ${pConds.join(' AND ')}
       ORDER BY COALESCE(p.reviewed_at, p.created_at) DESC
       LIMIT ?`
    ).bind(...pArgs).all();

    if (!recentPerfs || !recentPerfs.length) {
      return json({
        recent,
        singer: singer || null,
        total_b_links: 0,
        distinct_bv: 0,
        covered_bv: 0,
        missing_count: 0,
        missing: []
      });
    }

    const perfIds = recentPerfs.map((p) => p.id);
    const CHUNK = 80;
    for (let i = 0; i < perfIds.length; i += CHUNK) {
      const chunk = perfIds.slice(i, i + CHUNK);
      const { results: linkRows } = await env.DB.prepare(
        `SELECT l.performance_id, l.url, p.title AS perf_title, p.singer
         FROM links l
         JOIN performances p ON p.id = l.performance_id
         WHERE l.performance_id IN (${chunk.map(() => '?').join(',')})
           AND l.placeholder = 0
           AND (l.url LIKE '%bilibili%' OR l.url LIKE '%b23.tv%')`
      ).bind(...chunk).all();
      if (linkRows) links.push(...linkRows);
    }
  } else {
    // 2. 全库查模式：直接关联查出所有有效演出中的 B 站链接（轻量只读 url 与 performance_id）
    const conds = ["p.status = 'approved'", 'p.is_deleted = 0', 'l.placeholder = 0', "(l.url LIKE '%bilibili%' OR l.url LIKE '%b23.tv%')"];
    const args = [];
    if (singer) {
      conds.push('p.singer = ?');
      args.push(singer);
    }

    const { results: linkRows } = await env.DB.prepare(
      `SELECT l.performance_id, l.url, p.title AS perf_title, p.singer
       FROM links l
       JOIN performances p ON p.id = l.performance_id
       WHERE ${conds.join(' AND ')}`
    ).bind(...args).all();
    if (linkRows) links = linkRows;
  }

  // 3. 解析 BV 号与短链
  const bvToLinks = new Map();
  const shortLinks = [];

  for (const row of links) {
    const u = (row.url || '').trim();
    const bv = biliVideoId(u);
    if (bv) {
      if (!bvToLinks.has(bv)) bvToLinks.set(bv, []);
      bvToLinks.get(bv).push(row);
    } else if (/b23\.tv/i.test(u)) {
      shortLinks.push(row);
    }
  }

  // 4. 批量查 video_meta 是否有 cover_url
  const allBvs = [...bvToLinks.keys()];
  const coveredBvs = new Set();
  const CHUNK = 80;

  for (let i = 0; i < allBvs.length; i += CHUNK) {
    const chunk = allBvs.slice(i, i + CHUNK);
    const { results: metaRows } = await env.DB.prepare(
      `SELECT video_id, cover_url FROM video_meta
       WHERE provider = 'bilibili' AND video_id IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all();

    for (const m of metaRows || []) {
      if (m.cover_url && m.cover_url.trim()) {
        coveredBvs.add(m.video_id);
      }
    }
  }

  // 5. 组合缺失列表
  const missing = [];
  const seenMissing = new Set();

  for (const bv of allBvs) {
    if (wantAll || !coveredBvs.has(bv)) {
      const rows = bvToLinks.get(bv) || [];
      const primary = rows[0] || {};
      seenMissing.add(bv);
      missing.push({
        bv,
        url: primary.url,
        performance_id: primary.performance_id,
        perf_title: primary.perf_title,
        singer: primary.singer,
        is_short: false
      });
    }
  }

  // 未展开的 b23.tv 短链天然视为待解析补齐
  for (const sl of shortLinks) {
    if (!seenMissing.has(sl.url)) {
      seenMissing.add(sl.url);
      missing.push({
        bv: '',
        url: sl.url,
        performance_id: sl.performance_id,
        perf_title: sl.perf_title,
        singer: sl.singer,
        is_short: true
      });
    }
  }

  return json({
    recent: recent || null,
    singer: singer || null,
    total_b_links: links.length,
    distinct_bv: allBvs.length,
    covered_bv: coveredBvs.size,
    missing_count: missing.length,
    missing
  });
}
