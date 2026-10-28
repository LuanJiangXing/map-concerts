/* src/singers.js —— 歌手请求 / 歌手管理
 *
 * 流程:登录用户 POST /api/singer-requests 落 singer_requests(pending)
 *   → admin 在 review「歌手」tab 批准(approve 即 INSERT singers,slug 从 name_en 自动生成)
 *   → 驳回(reject)记录 reject_reason。
 * 权限:请求创建 = 登录+CSRF+限流(10/min + 5/day);
 *   审核 / 歌手管理 = admin+authed+CSRF+限流(并入 tag_edit 同款 60s/120)。
 * 公开 GET /api/singers 只返回 active 歌手;?admin=1(admin+authed)给 review 页返回全量。
 */
import {
  json, readBody, requireUser, requireAdmin, isAdminAuthed, csrfCheck, checkRateLimit, randomHex, nowStr, HttpError,
} from './db.js';

const META_INTENTS = ['provide', 'want'];

function str(v, max, label) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > max) throw new HttpError(400, `${label}过长(≤${max} 字)`);
  return s;
}

/** 编辑/申请口径:允许 http(s):// 或站内路径(/ 开头,非 //),与前端校验一致 */
function isValidPortraitOrPath(s) {
  return /^https?:\/\/\S+$/i.test(s) || /^\/(?!\/)/.test(s);
}

/** 生成 slug:name_en 小写、空格→`-`、去非 [a-z0-9-];全非 ASCII → 'singer' 兜底(可后续编辑) */
function makeSlug(nameEn) {
  const slug = String(nameEn || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'singer';
}

async function singerExists(env, id) {
  const { results } = await env.DB.prepare('SELECT id FROM singers WHERE id = ?').bind(id).all();
  return !!results[0];
}

/** 与现有 singers.id 冲突则追加 -2/-3… */
async function uniqueSingerId(env, base) {
  if (!(await singerExists(env, base))) return base;
  let i = 2;
  while (await singerExists(env, `${base}-${i}`)) i++;
  return `${base}-${i}`;
}

async function nextSortOrder(env) {
  const { results } = await env.DB.prepare('SELECT MAX(sort_order) AS m FROM singers').all();
  const m = results[0].m;
  return (m == null ? -1 : Number(m)) + 1;
}

async function requireAdminAuthed(request, env) {
  const user = await requireAdmin(request, env);
  if (!(await isAdminAuthed(request, env, user.id))) throw new HttpError(403, '需先输入审核密码解锁');
  return user;
}

/* ---------- 公开 GET /api/singers(active=1;?admin=1 全量,供 review 页歌手管理) ---------- */
async function handlePublicSingers(request, env, url) {
  const admin = url.searchParams.get('admin') === '1';
  if (admin) await requireAdminAuthed(request, env);

  const qSingers = env.DB.prepare(
    `SELECT s.id, s.name_zh, s.name_en, s.sort_order, s.portrait, s.intro, s.active,
            COUNT(p.id) AS performance_count,
            COUNT(DISTINCT p.city) AS city_count
     FROM singers s
     LEFT JOIN performances p ON p.singer = s.id AND p.status = 'approved' AND p.is_deleted = 0
     ${admin ? '' : 'WHERE s.active = 1'}
     GROUP BY s.id
     ORDER BY s.sort_order, s.id`
  );

  // 年份场次聚合:单次往返聚合各歌手演出年份计数,供首页头版年份条直接秒级渲染,免除拉取全量 /api/performances
  const qYears = env.DB.prepare(
    `SELECT singer, year, COUNT(*) AS count
     FROM performances
     WHERE status = 'approved' AND is_deleted = 0 AND year IS NOT NULL AND year != ''
     GROUP BY singer, year`
  );

  const [singersRes, yearsRes] = await env.DB.batch([qSingers, qYears]);
  const results = singersRes.results || [];
  const yearRows = yearsRes.results || [];
  const yearMap = {};
  for (const r of yearRows) {
    if (!yearMap[r.singer]) yearMap[r.singer] = {};
    yearMap[r.singer][r.year] = Number(r.count);
  }

  return json(results.map((r) => ({
    id: r.id,
    name_zh: r.name_zh,
    name_en: r.name_en || '',
    portrait: r.portrait || '',
    intro: r.intro || '',
    sort_order: Number(r.sort_order) || 0,
    active: !!r.active,
    performance_count: Number(r.performance_count),
    city_count: Number(r.city_count),
    year_counts: yearMap[r.id] || {},
  })));
}

/* ---------- POST /api/singer-requests(登录+CSRF+限流+校验+去重) ---------- */
async function handleCreateRequest(request, env, user) {
  csrfCheck(request);
  await checkRateLimit(env, 'sreq:' + user.id, 'singer_request', 600, 10);
  await checkRateLimit(env, 'sreq:' + user.id, 'singer_request_day', 86400, 5);
  const body = await readBody(request);

  const nameZh = str(body.name_zh, 30, '中文名');
  const nameEn = str(body.name_en, 30, '英文名');
  const portrait = str(body.portrait, 200, '大头照 URL');
  const intro = str(body.intro, 200, '简介');
  const metaIntent = String(body.meta_intent || '');
  if (!nameZh) throw new HttpError(400, '中文名必填');
  if (!nameEn) throw new HttpError(400, '英文名必填');
  if (!portrait) throw new HttpError(400, '大头照必填(可上传图片或填 URL)');
  if (!isValidPortraitOrPath(portrait)) throw new HttpError(400, '大头照需为 http(s):// 链接或站内 /uploads 路径');
  if (!metaIntent) throw new HttpError(400, '请选择意向');
  if (!META_INTENTS.includes(metaIntent)) throw new HttpError(400, '意向需为 provide 或 want');

  // 去重:①自己已请求过该歌手;②他人有 pending 同名请求(跨用户去重);③该歌手已入驻(active 或停用均算)
  const { results: dup } = await env.DB.prepare(
    'SELECT id FROM singer_requests WHERE user_id = ? AND name_zh = ?'
  ).bind(user.id, nameZh).all();
  if (dup[0]) throw new HttpError(409, '已请求过该歌手');
  const { results: otherPending } = await env.DB.prepare(
    "SELECT id FROM singer_requests WHERE name_zh = ? AND user_id != ? AND status = 'pending'"
  ).bind(nameZh, user.id).all();
  if (otherPending[0]) throw new HttpError(409, '该歌手正在审核中');
  const { results: existing } = await env.DB.prepare('SELECT id FROM singers WHERE name_zh = ?').bind(nameZh).all();
  if (existing[0]) throw new HttpError(409, '该歌手已入驻');

  const id = 'sreq-' + Date.now().toString(36) + '-' + randomHex(4);
  await env.DB.prepare(
    `INSERT INTO singer_requests (id, user_id, name_zh, name_en, portrait, intro, meta_intent, status, created_at)
     VALUES (?,?,?,?,?,?,?,'pending',?)`
  ).bind(id, user.id, nameZh, nameEn, portrait, intro, metaIntent, nowStr()).run();
  return json({ ok: true, id, status: 'pending' }, 201);
}

/* ---------- GET /api/singer-requests?status=(登录自己;admin+authed 全量) ---------- */
async function handleListRequests(request, env, user, url) {
  const status = url.searchParams.get('status');
  const isAdmin = user.role === 'admin' && (await isAdminAuthed(request, env, user.id));
  const conds = [];
  const args = [];
  if (!isAdmin) { conds.push('r.user_id = ?'); args.push(user.id); }
  if (status) { conds.push('r.status = ?'); args.push(status); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.user_id, r.name_zh, r.name_en, r.portrait, r.intro, r.meta_intent,
            r.status, r.reject_reason, r.created_at, r.reviewed_at,
            u.username AS username
     FROM singer_requests r
     LEFT JOIN users u ON u.id = r.user_id
     ${where}
     ORDER BY r.created_at DESC`
  ).bind(...args).all();
  return json({ requests: results.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    requester: r.username || '',
    username: r.username || '',
    name_zh: r.name_zh,
    name_en: r.name_en,
    portrait: r.portrait,
    intro: r.intro || '',
    meta_intent: r.meta_intent,
    status: r.status,
    reject_reason: r.reject_reason || '',
    created_at: r.created_at,
    reviewed_at: r.reviewed_at || null,
  })) });
}

/* ---------- PATCH /api/singer-requests/:id(admin+authed+CSRF+限流) ---------- */
async function handleRequestAction(request, env, user, id) {
  const body = await readBody(request);
  const action = String(body.action || '');
  const reason = String(body.reject_reason || '').slice(0, 300);

  const { results } = await env.DB.prepare('SELECT * FROM singer_requests WHERE id = ?').bind(id).all();
  const req = results[0];
  if (!req) throw new HttpError(404, '请求不存在');
  if (req.status !== 'pending') throw new HttpError(400, '仅待审请求可操作');

  if (action === 'approve') {
    // 复查入驻去重(可能已被另一请求批准建了同名歌手)
    const { results: dup } = await env.DB.prepare('SELECT id FROM singers WHERE name_zh = ?').bind(req.name_zh).all();
    if (dup[0]) throw new HttpError(409, '该歌手已入驻');

    // URL id(slug):默认按英文名自动生成;审批时可选传入 body.slug 覆盖(前端确认层)。
    // 约束小写字母/数字/连字符;纯中文英文名自动生成会兜底 'singer',故前端要求必填,
    // 后端收到空 slug 时回退自动生成(避免手工调用 API 卡死)。
    let base;
    const raw = String(body.slug || '').trim().toLowerCase();
    if (raw) {
      if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(raw)) throw new HttpError(400, 'slug 限小写字母/数字/连字符,≤60 字符');
      base = raw;
    } else {
      base = makeSlug(req.name_en);
    }
    const singerId = await uniqueSingerId(env, base);
    const sortOrder = await nextSortOrder(env);
    await env.DB.prepare(
      'INSERT INTO singers (id, name_zh, name_en, portrait, intro, sort_order, active) VALUES (?,?,?,?,?,?,1)'
    ).bind(singerId, req.name_zh, req.name_en, req.portrait, req.intro || '', sortOrder).run();
    await env.DB.prepare("UPDATE singer_requests SET status = 'approved', reviewed_at = ? WHERE id = ?")
      .bind(nowStr(), id).run();
    return json({ ok: true, action: 'approved', singer_id: singerId });
  }

  if (action === 'reject') {
    await env.DB.prepare(
      "UPDATE singer_requests SET status = 'rejected', reject_reason = ?, reviewed_at = ? WHERE id = ?"
    ).bind(reason, nowStr(), id).run();
    return json({ ok: true, action: 'rejected' });
  }

  throw new HttpError(400, 'action 必须是 approve 或 reject');
}

/* ---------- PATCH /api/singers/:id(admin+authed+CSRF+限流)
 *   action='toggle_active'(或 body.active=0/1)→ 停用/启用;
 *   否则(action='update' 或缺省)编辑 name_zh/name_en/portrait/intro/sort_order。 */
async function handleSingerPatch(request, env, user, id) {
  const body = await readBody(request);
  const action = String(body.action || '');

  const { results } = await env.DB.prepare('SELECT * FROM singers WHERE id = ?').bind(id).all();
  const singer = results[0];
  if (!singer) throw new HttpError(404, '歌手不存在');

  // 停用/启用 toggle:action='toggle_active' 或直接发 active=0/1
  if (action === 'toggle_active' || body.active !== undefined) {
    const currentActive = Number(singer.active) ? 1 : 0;
    const newActive = action === 'toggle_active'
      ? (currentActive ? 0 : 1)
      : (Number(body.active) ? 1 : 0);
    await env.DB.prepare('UPDATE singers SET active = ? WHERE id = ?').bind(newActive, id).run();
    return json({ ok: true, active: newActive });
  }

  // 编辑字段:name_zh / name_en / portrait / intro / sort_order(前端发 action='update')
  const nameZh = str(body.name_zh, 30, '中文名');
  const nameEn = str(body.name_en, 30, '英文名');
  const portrait = str(body.portrait, 200, '大头照');
  const intro = str(body.intro, 200, '简介');
  if (!nameZh) throw new HttpError(400, '中文名必填');
  if (!nameEn) throw new HttpError(400, '英文名必填');
  if (portrait && !isValidPortraitOrPath(portrait)) throw new HttpError(400, '大头照需为 http(s):// 链接或站内路径');
  let sortOrder;
  if (body.sort_order == null || body.sort_order === '') sortOrder = Number(singer.sort_order) || 0;
  else {
    sortOrder = Number(body.sort_order);
    if (!Number.isFinite(sortOrder)) throw new HttpError(400, '排序号需为数字');
  }
  await env.DB.prepare(
    'UPDATE singers SET name_zh=?, name_en=?, portrait=?, intro=?, sort_order=? WHERE id=?'
  ).bind(nameZh, nameEn, portrait, intro, sortOrder, id).run();
  return json({ ok: true });
}

/* ---------- DELETE /api/singers/:id(admin+authed+CSRF+限流) ---------- */
async function handleSingerDelete(request, env, user, id) {
  const { results } = await env.DB.prepare('SELECT id, name_zh FROM singers WHERE id = ?').bind(id).all();
  const singer = results[0];
  if (!singer) throw new HttpError(404, '歌手不存在');
  // 有 approved/pending 演出(含草稿行)→ 不可删,仅可停用
  const { results: perfs } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM performances WHERE singer = ? AND status IN ('approved','pending') AND is_deleted = 0"
  ).bind(id).all();
  if (Number(perfs[0].n) > 0) throw new HttpError(400, '该歌手下有演出,不能删除,可停用');
  await env.DB.prepare('DELETE FROM singers WHERE id = ?').bind(id).run();
  // 该歌手已 approved 的请求一并清态(同 name_zh 至多一条 approved,允许用户日后重新请求)
  await env.DB.prepare("DELETE FROM singer_requests WHERE name_zh = ? AND status = 'approved'").bind(singer.name_zh).run();
  return json({ ok: true });
}

/* ---------- 入口 ---------- */
export async function handleSingerRequests(request, env, url) {
  const method = request.method;
  const { pathname } = url;

  if (method === 'POST' && pathname === '/api/singer-requests') {
    const user = await requireUser(request, env);
    return handleCreateRequest(request, env, user);
  }

  if (method === 'GET' && pathname === '/api/singer-requests') {
    const user = await requireUser(request, env);
    return handleListRequests(request, env, user, url);
  }

  const m = pathname.match(/^\/api\/singer-requests\/([^/]+)$/);
  if (m && method === 'PATCH') {
    const user = await requireAdminAuthed(request, env);
    csrfCheck(request);
    await checkRateLimit(env, 'tag:' + user.id, 'tag_edit', 60, 120);
    return handleRequestAction(request, env, user, m[1]);
  }

  return json({ error: 'not found' }, 404);
}

export async function handleSingers(request, env, url) {
  const method = request.method;
  const { pathname } = url;

  if (method === 'GET' && pathname === '/api/singers') {
    return handlePublicSingers(request, env, url);
  }

  const m = pathname.match(/^\/api\/singers\/([^/]+)$/);
  if (m) {
    if (method !== 'PATCH' && method !== 'DELETE') return json({ error: 'not found' }, 404);
    const user = await requireAdminAuthed(request, env);
    csrfCheck(request);
    await checkRateLimit(env, 'tag:' + user.id, 'tag_edit', 60, 120);
    if (method === 'PATCH') return handleSingerPatch(request, env, user, m[1]);
    if (method === 'DELETE') return handleSingerDelete(request, env, user, m[1]);
  }

  return json({ error: 'not found' }, 404);
}
