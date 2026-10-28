/* src/video-id.js —— URL 解析纯函数叶子(无任何 import)
 *
 * 从 video-meta.js 抽出的共用解析,供抓取端(video-meta.js)与读取端(db.js attachLinks
 * 附封面)复用。独立成叶子模块是为了防 db.js 反引 video-meta.js 造成 import 环:
 * db.js 已被全后端 import,而 video-meta.js 依赖 db.js(json/限流)→ 解析放本文件,
 * db.js 只依赖本文件(无 import)。
 *
 * b23.tv 短链:BV 需要 follow 302 后才能取得 → 在只读/纯解析路径(providerOf/biliVideoId/
 * parseVideo)一律解析不出(返回 '' / null),读路径视为无 meta → 文字回退;真正的 b23 解析
 * 留给 /api/video-meta 抓取时(normalizeBilibiliUrl + redirect follow 后取 res.url 的 BV)。
 */

/** bilibili host 判定(与 submissions.js isBilibiliUrl / track-time.js isBilibili 同源) */
export function isBilibiliUrl(raw) {
  try {
    const h = new URL(String(raw || '').trim()).hostname.toLowerCase();
    return h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv' || h.endsWith('.b23.tv');
  } catch { return false; }
}

/** YouTube host 判定(youtube.com / 子域 / youtu.be;镜像 video-meta 原 isAllowedHost 的 YT 分支) */
export function isYoutubeUrl(raw) {
  try {
    const h = new URL(String(raw || '').trim()).hostname.toLowerCase();
    return h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com' ||
           h === 'music.youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com');
  } catch { return false; }
}

/** host 级平台判定:'youtube' | 'bilibili' | ''(非白名单/不可解析) */
export function providerOf(raw) {
  if (!String(raw || '').trim()) return '';
  if (isYoutubeUrl(raw)) return 'youtube';
  if (isBilibiliUrl(raw)) return 'bilibili';
  return '';
}

/** 从 YouTube URL 提取 video_id(v= / youtu.be 短链 / /embed|shorts|live|v/ 路径);无 → '' */
export function youtubeVideoId(raw) {
  const s = String(raw || '').trim();
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') return u.pathname.replace(/^\//, '').split('/')[0] || '';
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{6,})/.exec(u.pathname);
    if (m) return m[1];
  } catch (e) { /* fallthrough */ }
  const m2 = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(s);
  return m2 ? m2[1] : '';
}

/** 从 bilibili URL 提取视频路径段:BVxxxx 或 av123;b23 短链 follow 前取不到 → '' */
export function biliVideoId(raw) {
  const s = String(raw || '');
  let m = /\/video\/(BV[0-9A-Za-z]+)/.exec(s);
  if (m) return m[1];
  m = /\/video\/(av\d+)/i.exec(s);
  if (m) return m[1].toLowerCase();
  return '';
}

/** 归一 bilibili 链接到 canonical /video/<BV|av>(有视频段才归,无则原样,供抓取端 b23 redirect 用) */
export function normalizeBilibiliUrl(rawUrl) {
  const id = biliVideoId(rawUrl);
  return id ? 'https://www.bilibili.com/video/' + id : rawUrl;
}

/** 统一解析入口(读路径用):命中白名单且能解析出稳定 video_id → {provider, video_id} | null。
 *  placeholder/非法/av/BV 外的 bilibili(b23 短链等)解析不出 → null。 */
export function parseVideo(raw) {
  const provider = providerOf(raw);
  if (!provider) return null;
  const video_id = provider === 'youtube' ? youtubeVideoId(raw) : biliVideoId(raw);
  if (!video_id) return null;
  return { provider, video_id };
}
