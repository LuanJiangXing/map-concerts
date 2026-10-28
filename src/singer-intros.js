/* src/singer-intros.js —— 歌手微简介 (众包一句话简介, 每用户每歌手限 1 条, <=10 字, 审核后展示)
 *
 * 规范:
 *   - 任何登录用户均可提交不超过 10 个字符的微简介, 默认 status='pending'
 *   - 每个用户对同一歌手最多 1 条, 重复提交走 UPSERT (覆盖旧内容并重新置为 pending)
 *   - 公开 GET /api/singer-intros?singer={id} 仅返回 status='approved' 记录
 *   - 管理员 GET /api/singer-intros?admin=1&status=... 查看各状态记录
 *   - 管理员 PATCH /api/singer-intros/:id (action: approve | reject) 审核
 *   - 管理员 DELETE /api/singer-intros/:id (软删入 trash, trash 下再次 DELETE 彻底清除)
 */
import {
  json, readBody, requireUser, requireAdmin, isAdminAuthed, csrfCheck, checkRateLimit, randomHex, nowStr, HttpError,
} from './db.js';

async function requireAdminAuthed(request, env) {
  const user = await requireAdmin(request, env);
  if (!(await isAdminAuthed(request, env, user.id))) throw new HttpError(403, '需先输入审核密码解锁');
  return user;
}

/** 校验歌手是否存在 */
async function singerExists(env, singerId) {
  const { results } = await env.DB.prepare('SELECT id, name_zh FROM singers WHERE id = ?').bind(singerId).all();
  return results[0] || null;
}

/* ---------- 公开 GET /api/singer-intros?singer=... 或 管理员全量 ---------- */
async function handleGet(request, env, url) {
  const admin = url.searchParams.get('admin') === '1';
  const singer = url.searchParams.get('singer') || '';
  const status = url.searchParams.get('status') || (admin ? 'pending' : 'approved');

  if (admin) {
    await requireAdminAuthed(request, env);
    let sql = `
      SELECT si.id, si.singer_id, si.content, si.status, si.reject_reason,
             si.created_at, si.reviewed_at,
             COALESCE(u.display_name, u.username, '歌友') AS submitter_name,
             u.username AS submitter_username,
             s.name_zh AS singer_name
      FROM singer_intros si
      LEFT JOIN users u ON u.id = si.user_id
      LEFT JOIN singers s ON s.id = si.singer_id
      WHERE si.status = ?
    `;
    const args = [status];
    if (singer) {
      sql += ' AND si.singer_id = ?';
      args.push(singer);
    }
    sql += ' ORDER BY si.created_at DESC';
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return json({ ok: true, intros: results || [] });
  }

  // 公开接口: 必须指定 singer, 仅返回 status='approved'
  if (!singer) {
    return json({ ok: true, intros: [] });
  }

  const { results } = await env.DB.prepare(`
    SELECT si.id, si.singer_id, si.content, si.status, si.created_at,
           COALESCE(u.display_name, u.username, '歌友') AS submitter_name,
           s.name_zh AS singer_name
    FROM singer_intros si
    LEFT JOIN users u ON u.id = si.user_id
    LEFT JOIN singers s ON s.id = si.singer_id
    WHERE si.singer_id = ? AND si.status = 'approved'
    ORDER BY si.created_at ASC
  `).bind(singer).all();

  return json({
    ok: true,
    intros: results.map((r) => ({
      id: r.id,
      singer_id: r.singer_id,
      singer_name: r.singer_name || '',
      content: r.content,
      submitter_name: r.submitter_name,
      created_at: r.created_at,
    }))
  });
}

/* ---------- 登录用户 POST /api/singer-intros ---------- */
async function handlePost(request, env) {
  const user = await requireUser(request, env);
  csrfCheck(request);
  await checkRateLimit(env, `user:${user.id}`, 'singer_intro_post', 10, 60);

  const body = await readBody(request);
  const singerId = String(body.singer_id || '').trim();
  const content = String(body.content || '').trim();

  if (!singerId) throw new HttpError(400, '缺少歌手标识');
  const singer = await singerExists(env, singerId);
  if (!singer) throw new HttpError(400, '歌手不存在');

  if (!content) throw new HttpError(400, '微简介内容不能为空');
  if (content.length > 10) throw new HttpError(400, '简介不能超过 10 个字');

  const id = 'si-' + randomHex(8);
  const now = nowStr();

  // UPSERT: 每个用户对同一歌手限 1 条
  await env.DB.prepare(`
    INSERT INTO singer_intros (id, singer_id, user_id, content, status, reject_reason, created_at)
    VALUES (?, ?, ?, ?, 'pending', '', ?)
    ON CONFLICT(singer_id, user_id)
    DO UPDATE SET content = excluded.content, status = 'pending', reject_reason = '', created_at = excluded.created_at
  `).bind(id, singerId, user.id, content, now).run();

  return json({
    ok: true,
    message: '微简介已提交，审核通过后将公开展示',
    status: 'pending'
  }, 201);
}

/* ---------- 管理员 PATCH /api/singer-intros/:id ---------- */
async function handlePatch(request, env, id) {
  await requireAdminAuthed(request, env);
  csrfCheck(request);
  const body = await readBody(request);
  const action = body.action;

  if (action !== 'approve' && action !== 'reject') {
    throw new HttpError(400, '未知操作');
  }

  const { results } = await env.DB.prepare('SELECT id, status FROM singer_intros WHERE id = ?').bind(id).all();
  if (!results.length) throw new HttpError(404, '该条简介不存在');

  const now = nowStr();
  if (action === 'approve') {
    await env.DB.prepare(
      "UPDATE singer_intros SET status = 'approved', reject_reason = '', reviewed_at = ? WHERE id = ?"
    ).bind(now, id).run();
    return json({ ok: true, status: 'approved' });
  }

  // reject
  const reason = String(body.reject_reason || '').trim() || '未说明原因';
  await env.DB.prepare(
    "UPDATE singer_intros SET status = 'rejected', reject_reason = ?, reviewed_at = ? WHERE id = ?"
  ).bind(reason, now, id).run();
  return json({ ok: true, status: 'rejected' });
}

/* ---------- 管理员 DELETE /api/singer-intros/:id ---------- */
async function handleDelete(request, env, id) {
  await requireAdminAuthed(request, env);
  csrfCheck(request);

  const { results } = await env.DB.prepare('SELECT id, status FROM singer_intros WHERE id = ?').bind(id).all();
  if (!results.length) throw new HttpError(404, '该条简介不存在');

  const item = results[0];
  if (item.status === 'trash') {
    // 已经在回收站 → 彻底删除
    await env.DB.prepare('DELETE FROM singer_intros WHERE id = ?').bind(id).run();
    return json({ ok: true, purged: true });
  }

  // 移入回收站
  await env.DB.prepare("UPDATE singer_intros SET status = 'trash' WHERE id = ?").bind(id).run();
  return json({ ok: true, moved_to_trash: true });
}

/* ---------- 统一入口分发 ---------- */
export async function handleSingerIntros(request, env, url) {
  const method = request.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/singer-intros') {
    return handleGet(request, env, url);
  }
  if (method === 'POST' && pathname === '/api/singer-intros') {
    return handlePost(request, env);
  }

  const idMatch = pathname.match(/^\/api\/singer-intros\/([^/]+)$/);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    if (method === 'PATCH') return handlePatch(request, env, id);
    if (method === 'DELETE') return handleDelete(request, env, id);
  }

  return json({ error: 'not found' }, 404);
}
