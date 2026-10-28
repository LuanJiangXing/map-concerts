/* src/db.js —— D1 schema 引导 + 通用辅助
 *
 * ensureSchema():冷启动幂等建表/加列/空表种子(geoguide 同款模式)。
 * 远程 D1 首次请求即自动就绪,无需手动 SQL。
 */

import { syncAutoTags, ensureCategory, SONG_CATEGORY, tagKey, splitAliases } from './tags.js';
import { seedCityCoords } from './cities.js';
import { parseVideo } from './video-id.js';

export const enc = new TextEncoder();
export const SESSION_COOKIE = 'sid';
export const CSRF_COOKIE = 'csrf';
export const ADMIN_KEY_COOKIE = 'admin_key';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, customHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...customHeaders }
  });
}

export async function readBody(request, maxBytes = 100 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, '请求体过大');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, '请求体过大'); // 权威校验(content-length 可伪造/缺失)
  try { return JSON.parse(text); } catch { return {}; }
}

export function randomHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 解析 Cookie 头 → 对象 */
export function getCookies(request) {
  const h = request.headers.get('cookie');
  if (!h) return {};
  const out = {};
  for (const pair of h.split(';')) {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

/** 构造 Set-Cookie 值(dev http 不加 Secure,生产 https 加);maxAgeSec=null → 会话 cookie(关浏览器失效) */
export function cookieValue(request, name, value, maxAgeSec, opts = {}) {
  const secure = request.url.startsWith('https://') ? '; Secure' : '';
  const httpOnly = opts.httpOnly === false ? '' : '; HttpOnly';
  const maxAge = maxAgeSec == null ? '' : `; Max-Age=${maxAgeSec}`;
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${maxAge}${secure}${httpOnly}`;
}

export function clientIP(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

/** 读取当前登录用户(会话 → users),无则 null */
export async function getSessionUser(request, env) {
  const sid = getCookies(request)[SESSION_COOKIE];
  if (!sid) return null;
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.display_name, u.created_at, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(sid).all();
  return results[0] || null;
}

export async function requireUser(request, env) {
  const u = await getSessionUser(request, env);
  if (!u) throw new HttpError(401, '请先登录');
  if (u.role === 'banned') throw new HttpError(403, '账号已被封禁');
  return u;
}

export async function requireAdmin(request, env) {
  const u = await requireUser(request, env);
  if (u.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  return u;
}

/** CSRF double-submit:请求头 x-csrf-token 必须等于 csrf cookie */
export function csrfCheck(request) {
  const token = getCookies(request)[CSRF_COOKIE];
  const header = request.headers.get('x-csrf-token') || '';
  if (!token || !header || token !== header) throw new HttpError(403, 'CSRF 校验失败');
}

export function timingSafeEqualStr(a, b) {
  const A = enc.encode(a);
  const B = enc.encode(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 审核密码门:admin_key cookie = SHA-256(ADMIN_PASSWORD:user_id),无存储、可重算 */
export async function isAdminAuthed(request, env, userId) {
  const token = getCookies(request)[ADMIN_KEY_COOKIE];
  if (!token || !env.ADMIN_PASSWORD) return false;
  const expected = await sha256Hex(env.ADMIN_PASSWORD + ':' + userId);
  return timingSafeEqualStr(token, expected);
}

/** site owner(唯一能提权/降权 admin 的账号)= 全站第一个 admin(created_at 最早,并列取 id 最小)。
 *  对应用户不可被任何人修改;handleMe 把它作为 super_admin 带给前端。 */
export async function isSuperAdmin(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1"
  ).all();
  return results.length > 0 && results[0].id === userId;
}

/** 限流:key+action 在窗口秒内计数超过 max 抛 429 */
export async function checkRateLimit(env, key, action, windowSec, max) {
  await env.DB.prepare('INSERT INTO rate_limits (key, action) VALUES (?, ?)').bind(key, action).run();
  const { results } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM rate_limits
     WHERE key = ? AND action = ? AND created_at > datetime('now', '-' || ? || ' seconds')`
  ).bind(key, action, String(windowSec)).all();
  if (Number(results[0].n) > max) throw new HttpError(429, '操作太频繁,请稍后再试');
}

/* ---------- schema 引导 ---------- */

/** 执行一组 SQL。优先走 D1 的 batch:一组语句只算一次往返。
 *  引导的固定开销因此由 ~47 次降到 ~13 次 —— 免费版「每次 Worker 调用 50 次查询」的额度下,
 *  这是能否跑完的关键(不再贴着上限)。
 *  注:旧注释称「miniflare 本地 D1 的 batch 有校验问题」,已在 wrangler 4.127 实测不成立
 *  (22 张表 + 15 个索引均经 batch 建成)。为免个别运行时不接受 batch 内的 DDL,
 *  失败时退回逐条 —— 这批 SQL 全是 CREATE ... IF NOT EXISTS,重跑幂等,不会重复建。 */
async function batchSql(env, sqls) {
  if (!sqls.length) return;
  try {
    await env.DB.batch(sqls.map((s) => env.DB.prepare(s)));
  } catch (e) {
    // 不静默:降级会把这组语句退回 ~35 次串行往返(正是本次要消掉的成本),
    // 无声降级等于把问题藏起来,故留一条日志。
    console.warn('d1 batch failed, falling back to sequential:', e && e.message || e);
    for (const sql of sqls) await env.DB.prepare(sql).run();
  }
}

/* ---------- 一次性回填的标志位 ----------
 * 回填类步骤幂等但昂贵,且成本随数据量线性增长(如逐场 syncAutoTags:每场约 9 次串行 D1 往返)。
 * 它们本是「某次版本引入时补存量」的一次性动作,却写在 runSchemaBootstrap 里,
 * 于是**每次引导都重跑**。加标志位后每个回填在其生命周期内只执行一次。
 * schema_meta 是引导第一条建的表,此处可安全读写。 */
const ONCE_AUTO_TAGS = 'once:auto_tags_backfill';
const ONCE_SONG_SINGER = 'once:song_singer_backfill';

/** 该一次性回填是否已跑过 */
async function hasOnce(env, key) {
  const row = await env.DB.prepare('SELECT value FROM schema_meta WHERE key = ?').bind(key).first();
  return !!row;
}

/** 标记一次性回填已完成(在其成功之后调用,保证失败可重试) */
async function markOnce(env, key) {
  await env.DB.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
    .bind(key, 'done').run();
}

/** schema 版本门:库版本 ≥ 代码版本 → 稳态 0~1 次 D1 直接放行;否则全量引导一次后写版本。
 *
 * 为什么是「≥」而不是「==」:本站迁移**恒为纯加法**(ADD COLUMN / CREATE TABLE·INDEX
 * IF NOT EXISTS),旧代码不认识新列、只要不 SELECT 就无副作用 —— 所以「库比代码新」是**安全态**。
 * 用严格相等时,任何版本不一致(先写库 / 先部署 / 回滚代码)都会触发全量引导;而引导成本随
 * 演出条数线性增长(每场约 9 次串行 D1 往返)且**跑不完就永不置位**,会让之后每个 /api 请求
 * 都从头发起 —— 2026-09-14 生产因此挂了两次(见 .trellis/tasks/09-14-schema-gate-nonblocking)。
 *
 * ⚠️ 红线:一旦出现**破坏性**迁移(删列 / 改名 / 改语义),「≥」放行的前提即失效,
 * 必须改回严格相等并配合停机窗口,不能只改 SCHEMA_VERSION 了事。
 *
 * 未来改 schema:改 runSchemaBootstrap 引导 SQL + 递增 SCHEMA_VERSION。迁移本身建议走 CLI
 * (`wrangler d1 execute davidtao-db --remote --file=…`,不经 Worker、不占 Worker 查询额度),
 * 别把请求路径上的懒引导当迁移主力。 */
export const SCHEMA_VERSION = '13'; // v7: 软删回收站——performances.deleted_at;v8: reaction + 演出贡献署名;v9: 用户收藏 favorites;v10: 视频级封面/标题缓存 video_meta;v11: 逐曲时间轴分 P——performance_tracks.part;v12: 用户头像 users.avatar_url + 改名留痕 audit_log.detail;v13: 歌手用户微简介 singer_intros

export async function ensureSchema(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM schema_meta WHERE key = ?')
      .bind('version').first();
    // Number(null)=0、Number('')=0、Number('abc')=NaN → isFinite 兜底:值缺失/畸形一律走引导,
    // 不把坏数据误判成「已是最新」。空库(schema_meta 不存在)走 catch。
    const dbv = Number(row && row.value);
    if (Number.isFinite(dbv) && dbv >= Number(SCHEMA_VERSION)) return;
  } catch { /* schema_meta 不存在(新库/老库首启)→ 全量引导 */ }
  await runSchemaBootstrap(env);
  await env.DB.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
    .bind('version', SCHEMA_VERSION).run();
}

/** 全量幂等引导(建表/索引/补列/种子/自动标签回填)。仅版本门未命中时运行,勿直接改走全量路径。 */
async function runSchemaBootstrap(env) {
  await batchSql(env, [
    `CREATE TABLE IF NOT EXISTS schema_meta (
       key TEXT PRIMARY KEY, value TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS performances (
       id TEXT PRIMARY KEY, singer TEXT NOT NULL DEFAULT 'david-tao', year INTEGER NOT NULL,
       date TEXT, title TEXT NOT NULL, type TEXT NOT NULL DEFAULT '其他', venue TEXT,
       city TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
       verified INTEGER NOT NULL DEFAULT 0, note TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       status TEXT NOT NULL DEFAULT 'approved', user_id TEXT DEFAULT '',
       edit_target_id TEXT, reject_reason TEXT, is_deleted INTEGER NOT NULL DEFAULT 0, reviewed_at TEXT,
       deleted_at TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS links (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
       label TEXT NOT NULL, url TEXT NOT NULL, placeholder INTEGER NOT NULL DEFAULT 0,
       is_full INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX IF NOT EXISTS idx_links_perf ON links(performance_id)`,
    `CREATE TABLE IF NOT EXISTS singers (
       id TEXT PRIMARY KEY, name_zh TEXT NOT NULL, name_en TEXT, sort_order INTEGER DEFAULT 0, portrait TEXT,
       intro TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1
     )`,
    `CREATE TABLE IF NOT EXISTS singer_requests (
       id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name_zh TEXT NOT NULL, name_en TEXT NOT NULL,
       portrait TEXT NOT NULL, intro TEXT DEFAULT '',
       meta_intent TEXT NOT NULL DEFAULT 'provide' CHECK(meta_intent IN ('provide','want')),
       status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT DEFAULT '',
       created_at TEXT NOT NULL, reviewed_at TEXT,
       UNIQUE(user_id, name_zh)
     )`,
    `CREATE TABLE IF NOT EXISTS users (
       id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
       salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
       display_name TEXT DEFAULT '', avatar_url TEXT DEFAULT '',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS sessions (
       id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
       id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, action TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS tag_categories (
       id TEXT PRIMARY KEY, name TEXT NOT NULL,
       sort_order INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'approved', created_by TEXT DEFAULT '',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS tags (
       id TEXT PRIMARY KEY, name TEXT NOT NULL,
       category_id TEXT NOT NULL REFERENCES tag_categories(id),
       status TEXT NOT NULL DEFAULT 'pending', created_by TEXT DEFAULT '',
       performance_id TEXT, aliases TEXT DEFAULT '',
       singer_id TEXT DEFAULT '',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS performance_tags (
       performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
       tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
       PRIMARY KEY (performance_id, tag_id)
     )`,
    // 整场视频逐曲时间轴:v5。按 performance_id 存(link 主键每次提交重插不稳定,不按 link_id 锚定),
    // 展示时挂在 links.is_full=1 的那条整场链接下。name=提交者所填歌名(读时归一到规范 tag 名);seconds NULL=唱过但无时间。
    // part(v11)=bilibili 分 P(第几 P,缺省 1 单 P);seconds 语义 = 该曲在其 P 内起点秒(每 P 从 0 起)。
    `CREATE TABLE IF NOT EXISTS performance_tracks (
       performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
       position INTEGER NOT NULL,
       name TEXT NOT NULL,
       seconds INTEGER,
       part INTEGER NOT NULL DEFAULT 1,
       PRIMARY KEY (performance_id, position)
     )`,
    `CREATE TABLE IF NOT EXISTS city_coords (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       city TEXT UNIQUE NOT NULL,
       lat REAL NOT NULL,
       lng REAL NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       action TEXT NOT NULL,               -- set_role_admin / set_role_user / change_username
       actor_user_id TEXT NOT NULL,
       target_user_id TEXT NOT NULL,
       detail TEXT DEFAULT '',             -- 明细(JSON/文本);change_username 存旧名
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    // 页面访问埋点(A 方案:只存 page + 可选登录用户,不落 IP/UA/referer;
    // 匿名访客仅计数,无法反查个人;登录用户供 review「访问分析」)
    `CREATE TABLE IF NOT EXISTS page_views (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       page TEXT NOT NULL,
       user_id TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    // 大头照上传图(Worker /uploads/{id} 回吐;b64 存 base64 TEXT,免 D1 BLOB 序列化差异)
    `CREATE TABLE IF NOT EXISTS portrait_images (
       id TEXT PRIMARY KEY,              -- 'img-' + randomHex(8) → URL /uploads/img-…
       mime TEXT NOT NULL,               -- image/jpeg|webp|png|gif(原样回吐)
       b64 TEXT NOT NULL,                -- base64(无换行)
       user_id TEXT DEFAULT '',          -- 上传者(审计/日后清理)
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    // 演出反应(v8):每用户对每场演出每个选项至多一行;不同 type 并存(叠加);type 白名单后端校验。
    // 只允许对 approved 且未删的演出写入;计数 GROUP BY type,无冗余计数。
    // 硬删随 purgePerf 显式清理(reactions/credits 均在 purgePerf 循环内 DELETE),不依赖 FK 级联。
    `CREATE TABLE IF NOT EXISTS reactions (
       performance_id TEXT NOT NULL,
       user_id        TEXT NOT NULL,
       type           TEXT NOT NULL,
       created_at     TEXT,
       PRIMARY KEY (performance_id, user_id, type)
     )`,
    // 演出贡献署名(v8):累计「建议修改通过审核」的贡献者。performance_id=原演出行,user_id=修改者。
    // 写入点唯一 = review.applyApprove 草稿合并分支;排除原始提交者(自改不署名);PK 去重保留最早。
    `CREATE TABLE IF NOT EXISTS performance_credits (
       performance_id TEXT NOT NULL,
       user_id        TEXT NOT NULL,
       created_at     TEXT,
       PRIMARY KEY (performance_id, user_id)
     )`,
    // 用户收藏(v9):登录用户收藏单场公开演出。(performance_id, user_id) 行唯一 → 幂等
    // INSERT ON CONFLICT DO NOTHING(保留最早收藏时刻);idx_favorites_user 服务「我的收藏按收藏时间倒序」。
    // 只允许对 approved 且未删的演出写入;硬删随 purgePerf 显式清理(不依赖 FK 级联);软删/恢复保留。
    `CREATE TABLE IF NOT EXISTS favorites (
       performance_id TEXT NOT NULL,
       user_id        TEXT NOT NULL,
       created_at     TEXT,
       PRIMARY KEY (performance_id, user_id)
     )`,
    // 视频级封面/标题缓存(v10):以 (provider, video_id) 为键 —— link 主键在草稿合并流整批替换不稳定,
    // video 身份才稳定。写入点 = /api/video-meta 成功即 UPSERT(写穿,submit 解析命中即落库);
    // 读取端 attachLinks 按 link.url 解析出 (provider,video_id) 后批量查询回填 link.cover_url。
    // 纯缓存:purge 演出不级联删(孤儿行被下次同 key 写入刷新);无独立索引(主键即查)。
    `CREATE TABLE IF NOT EXISTS video_meta (
       provider   TEXT NOT NULL,
       video_id   TEXT NOT NULL,
       title      TEXT DEFAULT '',
       cover_url  TEXT DEFAULT '',
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (provider, video_id)
     )`,
    // 歌手用户微简介 (众包一句话简介, 每用户每歌手限 1 条, <=10 字, 审核后在首页以胶囊跑马灯展示)
    `CREATE TABLE IF NOT EXISTS singer_intros (
       id            TEXT PRIMARY KEY,
       singer_id     TEXT NOT NULL,
       user_id       TEXT NOT NULL,
       content       TEXT NOT NULL,
       status        TEXT NOT NULL DEFAULT 'pending',
       reject_reason TEXT DEFAULT '',
       created_at    TEXT NOT NULL,
       reviewed_at   TEXT,
       UNIQUE(singer_id, user_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_singer_intros_lookup ON singer_intros(singer_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_singer_intros_review ON singer_intros(status, created_at)`,
  ]);

  // 老库补列(pragma 判断,幂等)
  const { results: cols } = await env.DB.prepare('PRAGMA table_info(performances)').all();
  const have = new Set(cols.map((c) => c.name));
  for (const [name, def] of [
    ['status', "TEXT NOT NULL DEFAULT 'approved'"],
    ['user_id', "TEXT DEFAULT ''"],
    ['edit_target_id', 'TEXT'],
    ['reject_reason', 'TEXT'],
    ['is_deleted', 'INTEGER NOT NULL DEFAULT 0'],
    ['reviewed_at', 'TEXT'],
    ['deleted_at', 'TEXT'],
  ]) {
    if (!have.has(name)) await env.DB.prepare(`ALTER TABLE performances ADD COLUMN ${name} ${def}`).run();
  }

  // links 老库补列:整场视频标记(承载逐曲时间轴的链接;v5)
  const { results: lcols } = await env.DB.prepare('PRAGMA table_info(links)').all();
  if (!lcols.some((c) => c.name === 'is_full')) {
    await env.DB.prepare('ALTER TABLE links ADD COLUMN is_full INTEGER NOT NULL DEFAULT 0').run();
  }

  // performance_tracks 老库补列:分 P(part;v11)。老数据默认 1 语义不变(单 P 表现与 v10 完全一致)。
  const { results: ptcols } = await env.DB.prepare('PRAGMA table_info(performance_tracks)').all();
  if (!ptcols.some((c) => c.name === 'part')) {
    await env.DB.prepare('ALTER TABLE performance_tracks ADD COLUMN part INTEGER NOT NULL DEFAULT 1').run();
  }

  // singers 老库补列(简介/软删)+ 默认大头照
  const { results: scols } = await env.DB.prepare('PRAGMA table_info(singers)').all();
  if (!scols.some((c) => c.name === 'portrait')) {
    await env.DB.prepare('ALTER TABLE singers ADD COLUMN portrait TEXT').run();
  }
  if (!scols.some((c) => c.name === 'intro')) {
    await env.DB.prepare('ALTER TABLE singers ADD COLUMN intro TEXT DEFAULT \'\'').run();
  }
  if (!scols.some((c) => c.name === 'active')) {
    await env.DB.prepare('ALTER TABLE singers ADD COLUMN active INTEGER NOT NULL DEFAULT 1').run();
  }
  // 存量 david-tao 行 active=1(老库加列 DEFAULT 1 已覆盖,显式置位保幂等)
  await env.DB.prepare("UPDATE singers SET active = 1 WHERE id = 'david-tao'").run();
  await env.DB.prepare(
    "UPDATE singers SET portrait = '/images/avatars/david-tao.svg' WHERE id = 'david-tao' AND (portrait IS NULL OR portrait = '')"
  ).run();

  // tags 老库补列:别名(同歌不同写法,换行分隔;见 src/tags.js)
  const { results: tcols } = await env.DB.prepare('PRAGMA table_info(tags)').all();
  if (!tcols.some((c) => c.name === 'aliases')) {
    await env.DB.prepare("ALTER TABLE tags ADD COLUMN aliases TEXT DEFAULT ''").run();
  }
  // tags 老库补列:歌手归属(v6,歌曲类别内身份=(歌手,歌名);非歌曲类别恒 '')
  if (!tcols.some((c) => c.name === 'singer_id')) {
    await env.DB.prepare("ALTER TABLE tags ADD COLUMN singer_id TEXT DEFAULT ''").run();
  }

  // users 老库补列:头像值(v12)。空串 = 未设置 → 前端按 user.id 确定性分配内置默认
  const { results: ucols } = await env.DB.prepare('PRAGMA table_info(users)').all();
  if (!ucols.some((c) => c.name === 'avatar_url')) {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''").run();
  }
  // audit_log 老库补列:明细(v12)。改用户名时存旧名,供审计追溯(角色变更行留空串)
  const { results: acols } = await env.DB.prepare('PRAGMA table_info(audit_log)').all();
  if (!acols.some((c) => c.name === 'detail')) {
    await env.DB.prepare("ALTER TABLE audit_log ADD COLUMN detail TEXT DEFAULT ''").run();
  }

  await batchSql(env, [
    `CREATE INDEX IF NOT EXISTS idx_perf_status ON performances(status)`,
    `CREATE INDEX IF NOT EXISTS idx_perf_user_status ON performances(user_id, status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_perf_edit_target ON performances(edit_target_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rate_key_action ON rate_limits(key, action, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_tags_cat ON tags(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tags_status ON tags(status)`,
    `CREATE INDEX IF NOT EXISTS idx_perf_tags_p ON performance_tags(performance_id)`,
    `CREATE INDEX IF NOT EXISTS idx_perf_tags_t ON performance_tags(tag_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tracks_perf ON performance_tracks(performance_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_pv_user_created ON page_views(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at)`,
  ]);

  // 空库自动种歌手(占位演出不再自动种——地图保持为空,由用户提交经审核填充)
  const { results: srow } = await env.DB.prepare('SELECT COUNT(*) AS n FROM singers').all();
  if (Number(srow[0].n) === 0) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO singers (id, name_zh, name_en, sort_order, portrait) VALUES ('david-tao', '陶喆', 'David Tao', 0, '/images/avatars/david-tao.svg')"
    ).run();
  }

  // 存量已通过演出幂等 backfill 类型/年份 标签(AC7;一次性 —— 每场约 9 次 D1 往返,
  // 以前每次引导都对全库重跑,是引导成本随演出数线性增长的主因,故加标志位只跑一次)
  if (!(await hasOnce(env, ONCE_AUTO_TAGS))) {
    const { results: approvedPerfs } = await env.DB.prepare(
      "SELECT id, type, year FROM performances WHERE status = 'approved' AND is_deleted = 0"
    ).all();
    for (const p of approvedPerfs) {
      await syncAutoTags(env, { id: p.id, type: p.type, year: p.year });
    }
    await markOnce(env, ONCE_AUTO_TAGS);
  }

  // 「歌曲」类别:社区歌名标签容器(普通类别,ensureSchema 预置 approved)。
  // 若提交者曾建同名 pending 类别 → 升级 approved,否则公开目录/歌手筛选不可见。
  await ensureSongCategory(env);

  // 歌曲归属回填:v6 —— 存量歌曲标签按演出归属歌手(幂等,见 backfillSongSinger)。
  // 同属一次性(每首存量歌曲标签 2~4 次往返),加标志位避免每次引导重跑。
  if (!(await hasOnce(env, ONCE_SONG_SINGER))) {
    await backfillSongSinger(env);
    await markOnce(env, ONCE_SONG_SINGER);
  }

  // 城市坐标库:空表才种子(curated 60 + 存量 approved 城市)
  await seedCityCoords(env);
}

/** 歌曲归属回填(v6,幂等):对 singer_id='' 的歌曲类别标签按已关联演出归位歌手。
 *  approved → performance_tags→perf;提案锚点 → tags.performance_id→perf。
 *  无歌手(游离)→ 保持 ''(不进任何建议);多歌手(历史共用一条)→ 首歌手保原 id,其余各克隆并重指。 */
export async function backfillSongSinger(env) {
  const { results: legacy } = await env.DB.prepare(
    `SELECT t.id, t.category_id, t.name, t.aliases, t.status FROM tags t
     JOIN tag_categories c ON c.id = t.category_id
     WHERE c.name = ? AND t.singer_id = ''`
  ).bind(SONG_CATEGORY).all();
  for (const tag of legacy) {
    const { results: aS } = await env.DB.prepare(
      `SELECT DISTINCT p.singer AS s FROM performance_tags pt
       JOIN performances p ON p.id = pt.performance_id AND p.is_deleted = 0
       WHERE pt.tag_id = ?`
    ).bind(tag.id).all();
    const { results: pS } = await env.DB.prepare(
      `SELECT DISTINCT p.singer AS s FROM performances p
       JOIN tags t ON t.performance_id = p.id
       WHERE t.id = ? AND t.performance_id IS NOT NULL AND p.is_deleted = 0`
    ).bind(tag.id).all();
    const singers = [...new Set(aS.concat(pS).map((r) => r.s).filter(Boolean))];
    if (!singers.length) continue; // 游离 → 保持 ''
    if (singers.length === 1) {
      await env.DB.prepare('UPDATE tags SET singer_id = ? WHERE id = ?').bind(singers[0], tag.id).run();
      continue;
    }
    const primary = singers[0];
    await env.DB.prepare('UPDATE tags SET singer_id = ? WHERE id = ?').bind(primary, tag.id).run();
    for (const sg of singers.slice(1)) {
      const cid = 'tag-' + Date.now().toString(36) + '-' + randomHex(4);
      await env.DB.prepare(
        'INSERT INTO tags (id, name, category_id, status, created_by, aliases, singer_id) VALUES (?,?,?,?,?,?,?)'
      ).bind(cid, tag.name, tag.category_id, tag.status, '', tag.aliases, sg).run();
      await env.DB.prepare(
        `UPDATE performance_tags SET tag_id = ? WHERE tag_id = ? AND performance_id IN
         (SELECT id FROM performances WHERE singer = ? AND is_deleted = 0)`
      ).bind(cid, tag.id, sg).run();
    }
  }
}

/** 「歌曲」类别幂等确保:存在 → 置 approved(可能从 pending 升级);不存在 → 建 approved */
async function ensureSongCategory(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, status FROM tag_categories WHERE name = ? ORDER BY (status = 'approved') DESC, created_at ASC LIMIT 1"
  ).bind(SONG_CATEGORY).all();
  if (!results[0]) { await ensureCategory(env, SONG_CATEGORY, 'approved'); return; }
  if (results[0].status !== 'approved') {
    await env.DB.prepare('UPDATE tag_categories SET status = ? WHERE id = ?')
      .bind('approved', results[0].id).run();
  }
}

/** 附 tags 到演出数组(原地):每场 tags:[{ id, name, category_id, category_name }] */
export async function attachTags(env, perfs) {
  if (!perfs.length) return;
  const ids = perfs.map((p) => p.id);
  const byId = new Map(perfs.map((p) => [p.id, p]));
  const CHUNK = 80;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results: tagRows } = await env.DB.prepare(
      `SELECT pt.performance_id, t.id, t.name, t.category_id, t.singer_id, c.name AS category_name
       FROM performance_tags pt
       JOIN tags t ON t.id = pt.tag_id
       JOIN tag_categories c ON c.id = t.category_id
       WHERE pt.performance_id IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all();
    for (const row of tagRows || []) {
      const p = byId.get(row.performance_id);
      if (p) p.tags.push({ id: row.id, name: row.name, category_id: row.category_id, category_name: row.category_name, singer_id: row.singer_id || '' });
    }
  }
}

/** 全量替换某演出的 links(删+插)。links:[{label,url,is_full?}];placeholder 恒 0。
 *   link 主键每次替换都变 → 逐曲时间轴不按 link_id 关联,整场承载由 is_full 列标记。 */
export async function saveLinks(env, id, links) {
  await env.DB.prepare('DELETE FROM links WHERE performance_id = ?').bind(id).run();
  for (const l of links) {
    await env.DB.prepare(
      'INSERT INTO links (performance_id, label, url, placeholder, is_full) VALUES (?,?,?,0,?)'
    ).bind(id, l.label, l.url, l.is_full ? 1 : 0).run();
  }
}

/** 全量替换某演出的逐曲时间轴(删+插,按数组序定 position)。tracks:[{name,seconds|null,part?}] */
export async function saveTracks(env, id, tracks) {
  await env.DB.prepare('DELETE FROM performance_tracks WHERE performance_id = ?').bind(id).run();
  for (let i = 0; i < tracks.length; i++) {
    const p = Number(tracks[i].part);
    const part = Number.isInteger(p) && p >= 1 && p <= 999 ? p : 1;
    await env.DB.prepare(
      'INSERT INTO performance_tracks (performance_id, position, name, seconds, part) VALUES (?,?,?,?,?)'
    ).bind(id, i, tracks[i].name, tracks[i].seconds, part).run();
  }
}

/** 附 links 到演出数组(原地);is_full=该链接承载整场逐曲时间轴(至多一条)。
 *  cover_url(v10):对每条 link.url 经 video-id.parseVideo 解析出 (provider,video_id) → 批量查
 *  video_meta 回填;placeholder/解析不出(b23 短链等)→ 不查、cover_url:null(前端文字回退)。
 *  video_meta 是纯视频级缓存,空表/部分命中都无害。 */
export async function attachLinks(env, perfs) {
  if (!perfs.length) return;
  const ids = perfs.map((p) => p.id);
  const byId = new Map(perfs.map((p) => [p.id, p]));
  // video 键 → 命中的 link 对象数组(同视频可被多条 link 引用);键 `${provider}:${video_id}`
  const keyToLinks = new Map();
  const CHUNK = 80;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results: linkRows } = await env.DB.prepare(
      `SELECT performance_id, label, url, placeholder, is_full FROM links
       WHERE performance_id IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all();

    for (const row of linkRows || []) {
      const p = byId.get(row.performance_id);
      if (!p) continue;
      const link = { label: row.label, url: row.url, placeholder: !!row.placeholder, is_full: !!row.is_full, cover_url: null };
      p.links.push(link);
      if (row.placeholder) continue; // placeholder 种子行(无真实视频)不查 meta
      const parsed = parseVideo(row.url);
      if (!parsed) continue;
      const k = parsed.provider + ':' + parsed.video_id;
      let arr = keyToLinks.get(k);
      if (!arr) { arr = []; keyToLinks.set(k, arr); }
      arr.push(link);
    }
  }

  if (!keyToLinks.size) return;
  // 按 provider 分组批量查(主键 (provider,video_id) 可命中;量小,分批防超变量占位符)
  const byProvider = new Map();
  for (const k of keyToLinks.keys()) {
    const i = k.indexOf(':');
    const prov = k.slice(0, i), vid = k.slice(i + 1);
    if (!byProvider.has(prov)) byProvider.set(prov, []);
    byProvider.get(prov).push(vid);
  }
  for (const [prov, vids] of byProvider) {
    for (let i = 0; i < vids.length; i += CHUNK) {
      const chunk = vids.slice(i, i + CHUNK);
      const { results: metaRows } = await env.DB.prepare(
        `SELECT video_id, cover_url FROM video_meta
         WHERE provider = ? AND video_id IN (${chunk.map(() => '?').join(',')})`
      ).bind(prov, ...chunk).all();
      for (const m of metaRows) {
        const arr = keyToLinks.get(prov + ':' + m.video_id);
        if (arr) for (const l of arr) l.cover_url = m.cover_url || null;
      }
    }
  }
}

/** 附 tracks(逐曲时间轴)到演出数组(原地):p.tracks=[{position,name,seconds,part}]。
 *   name = 提交者所填歌名,按该场歌曲 tag(name + 别名,`tagKey` 归一)解析为规范名,
 *   未命中(歌仍在待审核等)保留原文 —— 让弹窗下拉与歌曲芯片/筛选同文案。
 *   part(v11)=分 P,缺省 1(老库加列后默认 1,读路径兼容)。
 *   自包含:内部自查歌曲 tag(带 aliases),不依赖 attachTags 先后。 */
export async function attachTracks(env, perfs) {
  if (!perfs.length) return;
  const ids = perfs.map((p) => p.id);
  const byId = new Map(perfs.map((p) => [p.id, p]));
  const CHUNK = 80;

  // 歌曲规范名映射(perfId → tagKey(name|alias) → canonical name)
  const canon = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results: songRows } = await env.DB.prepare(
      `SELECT pt.performance_id, t.name, t.aliases FROM performance_tags pt
       JOIN tags t ON t.id = pt.tag_id
       JOIN tag_categories c ON c.id = t.category_id
       WHERE pt.performance_id IN (${chunk.map(() => '?').join(',')}) AND c.name = ?`
    ).bind(...chunk, SONG_CATEGORY).all();
    for (const r of songRows || []) {
      let m = canon.get(r.performance_id);
      if (!m) { m = new Map(); canon.set(r.performance_id, m); }
      for (const n of [r.name].concat(splitAliases(r.aliases))) {
        const k = tagKey(n);
        if (k && !m.has(k)) m.set(k, r.name);
      }
    }
  }

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results: rows } = await env.DB.prepare(
      `SELECT performance_id, position, name, seconds, part FROM performance_tracks
       WHERE performance_id IN (${chunk.map(() => '?').join(',')}) ORDER BY position ASC`
    ).bind(...chunk).all();
    for (const row of rows || []) {
      const p = byId.get(row.performance_id);
      if (!p) continue;
      const m = canon.get(p.id);
      const name = (m && m.get(tagKey(row.name))) || row.name;
      (p.tracks = p.tracks || []).push({
        position: Number(row.position),
        name,
        seconds: row.seconds == null ? null : Number(row.seconds),
        part: row.part == null ? 1 : Number(row.part),
      });
    }
  }
}

/* ---------- 软删回收站(geoguide trash 模式,v7) ----------
 * 软删 = is_deleted=1 + deleted_at(UTC nowStr);原条与其未合并草稿(edit_target_id)同生命周期:
 * 删/恢复原条级联草稿;彻底清除(purge)原条连带清草稿、links/tracks/perf_tags、指向它的 pending 提案,
 * approved 标签以它为锚(performance_id)则置空锚点(标签本身保留在目录)。 */
export const TRASH_TTL_DAYS = 7;

/** 软删一条演出及其未合并草稿。幂等(守卫 is_deleted=0)。 */
export async function softDeletePerf(env, id) {
  const ts = nowStr();
  await env.DB.prepare('UPDATE performances SET is_deleted = 1, deleted_at = ? WHERE id = ? AND is_deleted = 0').bind(ts, id).run();
  await env.DB.prepare('UPDATE performances SET is_deleted = 1, deleted_at = ? WHERE edit_target_id = ? AND is_deleted = 0').bind(ts, id).run();
}

/** 恢复软删演出及其草稿。幂等(守卫 is_deleted=1)。 */
export async function restorePerf(env, id) {
  await env.DB.prepare('UPDATE performances SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND is_deleted = 1').bind(id).run();
  await env.DB.prepare('UPDATE performances SET is_deleted = 0, deleted_at = NULL WHERE edit_target_id = ? AND is_deleted = 1').bind(id).run();
}

/** 彻底清除一条演出:连同其未合并草稿、links/tracks/perf_tags、指向它的 pending 提案;
 *  approved 标签锚点置空。幂等(按 performance_id 删,行不存在即 no-op)。 */
export async function purgePerf(env, id) {
  const ids = [id];
  const { results: drafts } = await env.DB.prepare('SELECT id FROM performances WHERE edit_target_id = ?').bind(id).all();
  for (const d of drafts) ids.push(d.id);
  for (const pid of ids) {
    await env.DB.prepare('DELETE FROM links WHERE performance_id = ?').bind(pid).run();
    await env.DB.prepare('DELETE FROM performance_tracks WHERE performance_id = ?').bind(pid).run();
    await env.DB.prepare('DELETE FROM performance_tags WHERE performance_id = ?').bind(pid).run();
    await env.DB.prepare("DELETE FROM tags WHERE performance_id = ? AND status = 'pending'").bind(pid).run();
    await env.DB.prepare("UPDATE tags SET performance_id = NULL WHERE performance_id = ? AND status = 'approved'").bind(pid).run();
    // v8:reaction 与贡献署名随行硬删(reactions 只挂在 approved 行,此处在硬删前清除)
    await env.DB.prepare('DELETE FROM reactions WHERE performance_id = ?').bind(pid).run();
    await env.DB.prepare('DELETE FROM performance_credits WHERE performance_id = ?').bind(pid).run();
    // v9:用户收藏随行硬删(草稿 pid 无收藏,无害)
    await env.DB.prepare('DELETE FROM favorites WHERE performance_id = ?').bind(pid).run();
    await env.DB.prepare('DELETE FROM performances WHERE id = ?').bind(pid).run();
  }
}

/** 过期回收站自动清除(geoguide 模式:写接口顺带清理,无独立定时器)。软删超 TTL 天 → 硬删。 */
export async function cleanupTrash(env) {
  const { results } = await env.DB.prepare(
    'SELECT id FROM performances WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < datetime(\'now\', \'-\' || ? || \' days\')'
  ).bind(String(TRASH_TTL_DAYS)).all();
  for (const r of results) await purgePerf(env, r.id);
}

/** 限流表滚动清理(与 cleanupTrash 同写接口时机,无独立定时器)。checkRateLimit 每次只插不删
 *  (db.js checkRateLimit),表无界增长会烧 D1 写配额/拖慢查询。窗口最长 1 天(86400s),
 *  故保留 3 天即绝对安全。DELETE 带 LIMIT 子查询分批(避免一次性删大积压吃掉当日写配额)。 */
export const RATE_LIMIT_KEEP_DAYS = 3;
export async function cleanupRateLimits(env) {
  const cut = "datetime('now', '-' || ? || ' days')";
  await env.DB.prepare(
    `DELETE FROM rate_limits WHERE created_at < ${cut} AND id IN
       (SELECT id FROM rate_limits WHERE created_at < ${cut} LIMIT 2000)`
  ).bind(String(RATE_LIMIT_KEEP_DAYS), String(RATE_LIMIT_KEEP_DAYS)).run();
}
