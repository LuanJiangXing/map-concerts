/* src/review.js —— 审核(admin)
 *
 * 状态:pending / approved / rejected。
 * 草稿行(edit_target_id 非空)approve → 把业务字段拷贝回原行并删草稿;reject → 删草稿,原行不动。
 */
import { json, readBody, requireAdmin, isAdminAuthed, isSuperAdmin, csrfCheck, attachLinks, attachTags, attachTracks, saveLinks, saveTracks, checkRateLimit, nowStr, HttpError, softDeletePerf, restorePerf, purgePerf } from './db.js';
import { syncAutoTags, replacePerfNonAutoTags } from './tags.js';
import { rememberCity } from './cities.js';

export async function handleReview(request, env, url) {
  const user = await requireAdmin(request, env);
  if (!(await isAdminAuthed(request, env, user.id))) throw new HttpError(403, '需先输入审核密码解锁');
  const method = request.method;
  if (method === 'GET' && url.pathname === '/api/review') {
    return handleReviewList(env, url);
  }
  if (method === 'GET' && url.pathname === '/api/users') {
    return handleUsers(env);
  }
  if (method === 'GET' && url.pathname === '/api/audit') {
    return handleAuditList(env);
  }
  const um = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (um && method === 'PATCH') {
    csrfCheck(request);
    return handleUserRole(request, env, user, um[1]);
  }
  if (um && method === 'DELETE') {
    csrfCheck(request);
    return handleUserDelete(request, env, user, um[1]);
  }
  if (method === 'PATCH' && url.pathname === '/api/review') {
    csrfCheck(request);
    return handleReviewBatch(request, env, user);
  }
  const m = url.pathname.match(/^\/api\/review\/([^/]+)$/);
  if (m && method === 'PATCH') {
    csrfCheck(request);
    return handleReviewAction(request, env, user, m[1]);
  }
  // admin 删除(任意用户/状态)→ 软删进回收站
  if (m && method === 'DELETE') {
    csrfCheck(request);
    return handleAdminDelete(request, env, user, m[1]);
  }
  // admin 回收站操作(已在回收站的行):恢复 / 彻底删除
  const rm = url.pathname.match(/^\/api\/review\/([^/]+)\/(restore|purge)$/);
  if (rm && method === 'POST') {
    csrfCheck(request);
    return rm[2] === 'restore'
      ? handleAdminRestore(request, env, user, rm[1])
      : handleAdminPurge(request, env, user, rm[1]);
  }
  return json({ error: 'not found' }, 404);
}

async function handleReviewList(env, url) {
  const status = url.searchParams.get('status') || 'pending';
  const singer = url.searchParams.get('singer') || '';
  const singerCond = singer ? ' AND p.singer = ?' : '';
  const sel =
    `SELECT p.id, p.singer, p.year, p.date, p.title, p.type, p.venue, p.city, p.lat, p.lng,
            p.verified, p.note, p.status, p.user_id, p.edit_target_id, p.reject_reason,
            p.reviewed_at, p.created_at, p.deleted_at, u.username AS submitter,
            CASE WHEN p.edit_target_id IS NOT NULL THEN o.title END AS original_title,
            CASE WHEN p.edit_target_id IS NOT NULL THEN o.city END AS original_city
     FROM performances p
     LEFT JOIN users u ON u.id = p.user_id
     LEFT JOIN performances o ON o.id = p.edit_target_id`;
  let sql, args;
  if (status === 'trash') {
    // 回收站只列"原条 + 游离草稿(其原条仍在线)";随原条下架的草稿不单独列出(随原条恢复/清除)
    sql = sel + ` WHERE p.is_deleted = 1
            AND (p.edit_target_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM performances o2 WHERE o2.id = p.edit_target_id AND o2.is_deleted = 1))` +
      singerCond + ` ORDER BY p.deleted_at DESC, p.created_at DESC`;
    args = singer ? [singer] : [];
  } else {
    sql = sel + ` WHERE p.is_deleted = 0 AND p.status = ?` + singerCond + ` ORDER BY p.created_at ASC`;
    args = singer ? [status, singer] : [status];
  }
  const { results } = await env.DB.prepare(sql).bind(...args).all();

  const perfs = results.map((p) => ({
    ...p,
    verified: !!p.verified,
    links: [],
    tags: [],
    tracks: [],
    is_draft: !!p.edit_target_id,
  }));
  await attachLinks(env, perfs);
  await attachTags(env, perfs);
  await attachTracks(env, perfs);
  return json(perfs);
}

/** 注册用户列表(含各自提交统计 + is_owner 标记),供审核页"用户"栏目 */
async function handleUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.created_at,
            COUNT(CASE WHEN p.status = 'approved' THEN 1 END) AS approved,
            COUNT(CASE WHEN p.status = 'pending' THEN 1 END) AS pending,
            COUNT(CASE WHEN p.status = 'rejected' THEN 1 END) AS rejected
     FROM users u
     LEFT JOIN performances p ON p.user_id = u.id AND p.is_deleted = 0
     GROUP BY u.id
     ORDER BY u.created_at`
  ).all();
  // site owner = 最早 admin,单独算出便于前端打标 / 禁用
  const { results: owner } = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1"
  ).all();
  const ownerId = owner.length ? owner[0].id : '';
  return json(results.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    created_at: r.created_at,
    approved: Number(r.approved),
    pending: Number(r.pending),
    rejected: Number(r.rejected),
    is_owner: r.id === ownerId,
  })));
}

/** 改用户角色或封禁/解封:
 *  - 涉及 admin 角色变更(提升至 admin 或变更 admin 角色)仅 site owner 可操作
 *  - 普通 admin 可对普通用户执行 ban 或 unban(恢复为 user)
 *  - 不可操作自己、不可操作 site owner
 *  - 封禁(role='banned')时立即清空其会话(踢下线)
 *  - role 实际变化才落库并记 audit_log */
async function handleUserRole(request, env, user, id) {
  await checkRateLimit(env, 'uadm:' + user.id, 'user_admin', 60, 20);
  const body = await readBody(request);
  const role = String(body.role || '');
  if (role !== 'admin' && role !== 'user' && role !== 'banned') {
    throw new HttpError(400, 'role 必须是 admin、user 或 banned');
  }
  if (id === user.id) throw new HttpError(400, '不能修改自己的角色');

  const { results } = await env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?').bind(id).all();
  const target = results[0];
  if (!target) throw new HttpError(404, '用户不存在');
  if (await isSuperAdmin(env, target.id)) throw new HttpError(403, '不能修改 site owner');

  const isActorSuper = await isSuperAdmin(env, user.id);
  if ((role === 'admin' || target.role === 'admin') && !isActorSuper) {
    throw new HttpError(403, '仅 site owner 可变更管理员角色');
  }

  if (target.role === role) return json({ ok: true, role, unchanged: true });

  // 变更 admin 前保底:全站至少保留一个 admin(owner 不可改,此处恒安全,防御性保留)
  if (target.role === 'admin' && role !== 'admin') {
    const { results: admins } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?"
    ).bind(target.id).all();
    if (Number(admins[0].n) === 0) throw new HttpError(400, '至少保留一个管理员');
  }

  await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, target.id).run();

  // 若被封禁,立即踢出全部登录会话
  if (role === 'banned') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run();
  }

  await env.DB.prepare(
    'INSERT INTO audit_log (action, actor_user_id, target_user_id, detail) VALUES (?, ?, ?, ?)'
  ).bind('set_role_' + role, user.id, target.id, target.username).run();

  return json({ ok: true, role });
}

/** 彻底删除用户(清理 bot / 垃圾账号):
 *  - 守卫:不可删自己、不可删 site owner、删除 admin 仅 site owner 可操作且至少保留一个 admin
 *  - 级联清理:会话、收藏、reactions、演出贡献、加歌手申请、未通过提案标签与未通过/已删演出整条彻底清理
 *  - 公开演出脱敏保留:已通过且在线的演出将 user_id 置空,避免公共数据断裂
 *  - 写入 audit_log(action: delete_user, detail: target.username) */
async function handleUserDelete(request, env, user, id) {
  await checkRateLimit(env, 'udel:' + user.id, 'user_delete', 60, 20);
  if (id === user.id) throw new HttpError(400, '不能删除自己');

  const { results } = await env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?').bind(id).all();
  const target = results[0];
  if (!target) throw new HttpError(404, '用户不存在');
  if (await isSuperAdmin(env, target.id)) throw new HttpError(403, '不能删除 site owner');

  const isActorSuper = await isSuperAdmin(env, user.id);
  if (target.role === 'admin' && !isActorSuper) {
    throw new HttpError(403, '仅 site owner 可删除管理员');
  }

  if (target.role === 'admin') {
    const { results: admins } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?"
    ).bind(target.id).all();
    if (Number(admins[0].n) === 0) throw new HttpError(400, '至少保留一个管理员');
  }

  // 1. 清除用户全部会话
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run();
  // 2. 清除收藏、reactions、演出贡献、加歌手申请
  await env.DB.prepare('DELETE FROM favorites WHERE user_id = ?').bind(target.id).run();
  await env.DB.prepare('DELETE FROM reactions WHERE user_id = ?').bind(target.id).run();
  await env.DB.prepare('DELETE FROM performance_credits WHERE user_id = ?').bind(target.id).run();
  await env.DB.prepare('DELETE FROM singer_requests WHERE user_id = ?').bind(target.id).run();
  // 3. 上传大头照解除作者绑定(图保留防断链)
  await env.DB.prepare("UPDATE portrait_images SET user_id = '' WHERE user_id = ?").bind(target.id).run();
  // 4. 清理该用户未通过的提案标签,已通过标签脱敏保留
  await env.DB.prepare("DELETE FROM tags WHERE created_by = ? AND status = 'pending'").bind(target.id).run();
  await env.DB.prepare("UPDATE tags SET created_by = '' WHERE created_by = ?").bind(target.id).run();
  // 5. 演出级联清理:未通过或已删的整条清理,已通过且在线的保留但作者置空
  const { results: unapprovedPerfs } = await env.DB.prepare(
    "SELECT id FROM performances WHERE user_id = ? AND (status != 'approved' OR is_deleted = 1)"
  ).bind(target.id).all();
  for (const p of unapprovedPerfs) {
    await env.DB.prepare('DELETE FROM links WHERE performance_id = ?').bind(p.id).run();
    await env.DB.prepare('DELETE FROM performance_tracks WHERE performance_id = ?').bind(p.id).run();
    await env.DB.prepare('DELETE FROM performance_tags WHERE performance_id = ?').bind(p.id).run();
    await env.DB.prepare("DELETE FROM tags WHERE performance_id = ? AND status = 'pending'").bind(p.id).run();
    await env.DB.prepare('DELETE FROM performances WHERE id = ?').bind(p.id).run();
  }
  await env.DB.prepare("UPDATE performances SET user_id = '' WHERE user_id = ?").bind(target.id).run();

  // 6. 彻底删除用户行
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target.id).run();

  // 7. 记入审计日志(detail 存已删用户名,方便日志追溯)
  await env.DB.prepare(
    'INSERT INTO audit_log (action, actor_user_id, target_user_id, detail) VALUES (?, ?, ?, ?)'
  ).bind('delete_user', user.id, target.id, target.username).run();

  return json({ ok: true, deleted: target.username });
}

/** 审计日志最近 100 条(admin 对用户角色变更,JOIN 出双方用户名) */
async function handleAuditList(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.action, a.target_user_id, a.actor_user_id, a.created_at, a.detail,
            au.username AS actor_name, tu.username AS target_name
     FROM audit_log a
     LEFT JOIN users au ON au.id = a.actor_user_id
     LEFT JOIN users tu ON tu.id = a.target_user_id
     ORDER BY a.created_at DESC, a.id DESC LIMIT 100`
  ).all();
  return json({ logs: results });
}

/** 校验并加载一条待审核目标(不存在 / 已删 / 非 pending 均报错) */
async function getPendingTarget(env, id) {
  const { results } = await env.DB.prepare('SELECT * FROM performances WHERE id = ?').bind(id).all();
  const target = results[0];
  if (!target || Number(target.is_deleted)) throw new HttpError(404, '条目不存在');
  if (target.status !== 'pending') throw new HttpError(400, '仅待审核条目可操作');
  return target;
}

/** 驳回一条:清该行 pending 提案与全部标签关联;草稿 → 删草稿、原条目不动 */
async function applyReject(env, t, reason) {
  await env.DB.prepare("DELETE FROM tags WHERE performance_id = ? AND status = 'pending'").bind(t.id).run();
  await env.DB.prepare('DELETE FROM performance_tags WHERE performance_id = ?').bind(t.id).run();
  if (t.edit_target_id) {
    await env.DB.prepare(
      "DELETE FROM tags WHERE performance_id = ? AND status = 'pending' AND created_by = ?"
    ).bind(t.edit_target_id, t.user_id).run();
    await env.DB.prepare('DELETE FROM performances WHERE id = ?').bind(t.id).run();
    await env.DB.prepare('DELETE FROM links WHERE performance_id = ?').bind(t.id).run();
    await env.DB.prepare('DELETE FROM performance_tracks WHERE performance_id = ?').bind(t.id).run();
  } else {
    await env.DB.prepare('UPDATE performances SET status = ?, reject_reason = ?, reviewed_at = ? WHERE id = ?')
      .bind('rejected', reason, nowStr(), t.id).run();
  }
}

/** 通过一条:草稿 → 业务字段拷回原行并删草稿;普通 → 直接通过;均派生自动标签 + 城市写回 */
export async function applyApprove(env, t) {
  if (t.edit_target_id) {
    // 防把修改合并进已下架(回收站)的原条:先恢复原条再审核
    const { results: orig } = await env.DB.prepare(
      'SELECT id, is_deleted, user_id FROM performances WHERE id = ?').bind(t.edit_target_id).all();
    if (orig[0] && Number(orig[0].is_deleted)) throw new HttpError(400, '原演出在回收站,请先恢复再审核');
    // 草稿合并:业务字段拷贝回原行(不覆盖 id/user_id/created_at/edit_target_id/verified),删草稿
    await env.DB.prepare(
      `UPDATE performances
       SET singer=?, year=?, date=?, title=?, type=?, venue=?, city=?, lat=?, lng=?, note=?,
           status='approved', is_deleted=0, reject_reason='', reviewed_at=?
       WHERE id = ?`
    ).bind(t.singer, t.year, t.date, t.title, t.type, t.venue, t.city, t.lat, t.lng, t.note, nowStr(), t.edit_target_id).run();
    // v8 贡献署名:修改者(草稿作者)≠ 原提交者才记 credit;自改不署名。PK 去重保留首次。
    // 原行 user_id 永不覆盖 → 提交者永久署名,修改者走 performance_credits 累计。
    if (orig[0] && orig[0].user_id && orig[0].user_id !== t.user_id) {
      await env.DB.prepare(
        'INSERT INTO performance_credits (performance_id, user_id, created_at) VALUES (?,?,?) ' +
        'ON CONFLICT(performance_id, user_id) DO NOTHING'
      ).bind(t.edit_target_id, t.user_id, nowStr()).run();
    }
    // 原条目 links 换成草稿的 links(含整场 is_full 标记;v5)
    const { results: dl } = await env.DB.prepare('SELECT label, url, is_full FROM links WHERE performance_id = ?').bind(t.id).all();
    await saveLinks(env, t.edit_target_id, dl.map((l) => ({ label: l.label, url: l.url, is_full: !!l.is_full })));
    // 原条目逐曲时间轴换成草稿的(逐行搬入,含秒与分 P);v5/v11 —— 草稿行数据随后整行删除,不残留
    const { results: dtr } = await env.DB.prepare(
      'SELECT position, name, seconds, part FROM performance_tracks WHERE performance_id = ? ORDER BY position ASC'
    ).bind(t.id).all();
    await saveTracks(env, t.edit_target_id, dtr.map((k) => ({ name: k.name, seconds: k.seconds, part: k.part })));
    // 非自动标签:原行换成草稿的关联;自动标签按合并后的 type/year 重新派生
    const { results: dTags } = await env.DB.prepare(
      `SELECT pt.tag_id FROM performance_tags pt
       JOIN tags t ON t.id = pt.tag_id
       JOIN tag_categories c ON c.id = t.category_id
       WHERE pt.performance_id = ? AND c.name NOT IN ('类型', '年份')`
    ).bind(t.id).all();
    await replacePerfNonAutoTags(env, t.edit_target_id, dTags.map((r) => r.tag_id));
    await syncAutoTags(env, { id: t.edit_target_id, type: t.type, year: t.year });
    await env.DB.prepare('DELETE FROM performances WHERE id = ?').bind(t.id).run();
    await env.DB.prepare('DELETE FROM links WHERE performance_id = ?').bind(t.id).run();
    await env.DB.prepare('DELETE FROM performance_tracks WHERE performance_id = ?').bind(t.id).run();
    await env.DB.prepare('DELETE FROM performance_tags WHERE performance_id = ?').bind(t.id).run();
    // 城市坐标库自增长:用草稿行字段(= 将拷回原行的最终城市坐标)
    await rememberCity(env, t.city, Number(t.lat), Number(t.lng));
    return 'merged';
  }
  // 普通待审:直接通过 + 派生自动标签
  await env.DB.prepare(
    "UPDATE performances SET status='approved', is_deleted=0, reject_reason='', reviewed_at=? WHERE id = ?"
  ).bind(nowStr(), t.id).run();
  await syncAutoTags(env, { id: t.id, type: t.type, year: t.year });
  await rememberCity(env, t.city, Number(t.lat), Number(t.lng));
  return 'approved';
}

async function handleReviewAction(request, env, user, id) {
  await checkRateLimit(env, 'rev:' + user.id, 'review_act', 60, 30);
  const body = await readBody(request);
  const action = String(body.action || '');
  const reason = String(body.reject_reason || '').slice(0, 300) || '未说明';
  const target = await getPendingTarget(env, id);

  if (action === 'reject') {
    await applyReject(env, target, reason);
    return json({ ok: true, action: 'rejected' });
  }
  if (action === 'approve') {
    const acted = await applyApprove(env, target);
    return json({ ok: true, action: acted });
  }
  throw new HttpError(400, 'action 必须是 approve 或 reject');
}

/** 批量通过 / 驳回(仿 geoguide):一次 ≤50 条,预校验全 pending 后逐条走单条同款逻辑 */
async function handleReviewBatch(request, env, user) {
  await checkRateLimit(env, 'revb:' + user.id, 'review_batch', 60, 20);
  const body = await readBody(request);
  if (body.action !== 'batch') throw new HttpError(400, 'action 必须为 batch');
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = raw.filter((x) => typeof x === 'string' && x).filter((v, i, a) => a.indexOf(v) === i);
  if (!ids.length) throw new HttpError(400, 'ids 需为非空数组');
  if (ids.length > 50) throw new HttpError(400, '单次最多 50 条');
  const op = String(body.op || '');
  if (op !== 'approve' && op !== 'reject') throw new HttpError(400, 'op 必须是 approve 或 reject');
  const reason = String(body.reject_reason || '').slice(0, 300) || '未说明';

  // 预校验:全部存在、未删、pending,再动手,避免批处理中途翻车
  const ph = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT * FROM performances WHERE id IN (${ph})`).bind(...ids).all();
  const byId = new Map(results.map((r) => [r.id, r]));
  const bad = ids.filter((x) => { const r = byId.get(x); return !r || Number(r.is_deleted) || r.status !== 'pending'; });
  if (bad.length) throw new HttpError(400, '以下条目不在待审核状态:' + bad.slice(0, 10).join(','));

  for (const id of ids) {
    const t = byId.get(id);
    if (op === 'approve') await applyApprove(env, t);
    else await applyReject(env, t, reason);
  }
  return json({ ok: true, op: op, processed: ids.length });
}

/* ---------- 回收站(v7):admin 软删任意提交 + 恢复 / 彻底删除 ---------- */

/** admin 软删任意提交(任意用户/任意状态)→ 回收站(与作者侧共用 softDeletePerf)。 */
async function handleAdminDelete(request, env, user, id) {
  await checkRateLimit(env, 'revdel:' + user.id, 'review_delete', 60, 30);
  await assertTrashTarget(env, id, { mustBeTrash: false });
  await softDeletePerf(env, id);
  return json({ ok: true });
}

/** admin 从回收站恢复一条(原条级联其草稿)。 */
async function handleAdminRestore(request, env, user, id) {
  await checkRateLimit(env, 'revrst:' + user.id, 'review_restore', 60, 30);
  await assertTrashTarget(env, id, { mustBeTrash: true });
  await restorePerf(env, id);
  return json({ ok: true });
}

/** admin 从回收站彻底删除一条(连同关联草稿/pending 提案)。 */
async function handleAdminPurge(request, env, user, id) {
  await checkRateLimit(env, 'revpurge:' + user.id, 'review_purge', 60, 30);
  await assertTrashTarget(env, id, { mustBeTrash: true });
  await purgePerf(env, id);
  return json({ ok: true });
}

/** 校验操作目标存在且回收站状态符合预期(mustBeTrash)。 */
async function assertTrashTarget(env, id, want) {
  const { results } = await env.DB.prepare(
    'SELECT id, is_deleted FROM performances WHERE id = ?').bind(id).all();
  const t = results[0];
  if (!t) throw new HttpError(404, '条目不存在');
  const inTrash = Number(t.is_deleted) === 1;
  if (want.mustBeTrash && !inTrash) throw new HttpError(400, '条目不在回收站');
  if (!want.mustBeTrash && inTrash) throw new HttpError(400, '条目已在回收站');
}
