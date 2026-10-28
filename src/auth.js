/* src/auth.js —— 用户名+密码认证(自包含,无外部依赖)
 *
 * 密码:WebCrypto PBKDF2-SHA256(100k 迭代)+ 16B 随机盐,存盐+哈希。
 * 会话:token 存 sessions 表,HttpOnly cookie `sid`;CSRF double-submit cookie `csrf`。
 */
import {
  enc, json, readBody, getCookies, cookieValue,
  SESSION_COOKIE, CSRF_COOKIE, ADMIN_KEY_COOKIE,
  getSessionUser, requireUser, csrfCheck, checkRateLimit, clientIP, randomHex,
  sha256Hex, isAdminAuthed, isSuperAdmin, timingSafeEqualStr, HttpError,
} from './db.js';

const SESSION_DAYS = 30;
const validUsername = (u) => /^[\p{Script=Han}A-Za-z0-9_-]{2,20}$/u.test(u);

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function createSession(env, userId, request, res) {
  const sid = randomHex(32);
  const csrf = randomHex(16);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)')
    .bind(sid, userId, expiresAt).run();
  res.headers.append('Set-Cookie', cookieValue(request, SESSION_COOKIE, sid, SESSION_DAYS * 86400));
  res.headers.append('Set-Cookie', cookieValue(request, CSRF_COOKIE, csrf, SESSION_DAYS * 86400, { httpOnly: false }));
}

export async function handleAuth(request, env, url) {
  if (request.method === 'GET' && url.pathname === '/api/auth/me') return handleMe(request, env);
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (url.pathname === '/api/auth/register') return handleRegister(request, env);
  if (url.pathname === '/api/auth/login') return handleLogin(request, env);
  if (url.pathname === '/api/auth/logout') return handleLogout(request, env);
  if (url.pathname === '/api/auth/password') return handlePassword(request, env);
  if (url.pathname === '/api/auth/username') return handleUsername(request, env);
  if (url.pathname === '/api/auth/avatar') return handleAvatar(request, env);
  if (url.pathname === '/api/auth/admin-auth') return handleAdminAuth(request, env);
  return json({ error: 'not found' }, 404);
}

async function handleRegister(request, env) {
  await checkRateLimit(env, 'reg:' + clientIP(request), 'register', 3600, 5);
  const body = await readBody(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!validUsername(username)) throw new HttpError(400, '用户名需 2-20 位汉字/字母/数字/下划线/短横线');
  if (password.length < 8 || password.length > 72) throw new HttpError(400, '密码需 8-72 位');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).all();
  if (existing.results.length) throw new HttpError(409, '用户名已被占用');

  const salt = randomHex(16);
  const password_hash = await hashPassword(password, salt);
  const id = randomHex(16);
  // 首个管理员:用户名匹配 BOOTSTRAP_ADMIN 且库中尚无 admin
  let role = 'user';
  if (env.BOOTSTRAP_ADMIN && username === env.BOOTSTRAP_ADMIN) {
    const { results: admins } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").all();
    if (Number(admins[0].n) === 0) role = 'admin';
  }
  await env.DB.prepare('INSERT INTO users (id, username, password_hash, salt, role, display_name) VALUES (?,?,?,?,?,?)')
    .bind(id, username, password_hash, salt, role, username).run();

  const res = json({ ok: true, user: { id, username, role } }, 201);
  await createSession(env, id, request, res);
  return res;
}

async function handleLogin(request, env) {
  const body = await readBody(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  await checkRateLimit(env, 'login:' + username, 'login', 300, 10);
  await checkRateLimit(env, 'login_ip:' + clientIP(request), 'login_ip', 300, 20);

  const { results } = await env.DB.prepare('SELECT id, username, role, password_hash, salt FROM users WHERE username = ?').bind(username).all();
  const u = results[0];
  if (!u) throw new HttpError(401, '用户名或密码错误');
  const hash = await hashPassword(password, u.salt);
  if (!timingSafeEqualStr(hash, u.password_hash)) throw new HttpError(401, '用户名或密码错误');
  if (u.role === 'banned') throw new HttpError(403, '账号已被封禁');

  const res = json({ ok: true, user: { id: u.id, username: u.username, role: u.role } });
  await createSession(env, u.id, request, res);
  return res;
}

async function handleLogout(request, env) {
  csrfCheck(request);
  const sid = getCookies(request)[SESSION_COOKIE];
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', cookieValue(request, SESSION_COOKIE, '', 0));
  res.headers.append('Set-Cookie', cookieValue(request, CSRF_COOKIE, '', 0, { httpOnly: false }));
  res.headers.append('Set-Cookie', cookieValue(request, ADMIN_KEY_COOKIE, '', 0));
  return res;
}

async function handleMe(request, env) {
  const user = await getSessionUser(request, env);
  const res = json(user && user.role !== 'banned'
    ? {
        id: user.id, username: user.username, role: user.role,
        display_name: user.display_name, created_at: user.created_at,
        avatar_url: user.avatar_url || '',
        admin_auth: user.role === 'admin' ? await isAdminAuthed(request, env, user.id) : false,
        super_admin: user.role === 'admin' ? await isSuperAdmin(env, user.id) : false,
      }
    : null);
  // 回填 csrf cookie(未登录也可,便于后续登录流程)
  if (!getCookies(request)[CSRF_COOKIE]) {
    res.headers.append('Set-Cookie', cookieValue(request, CSRF_COOKIE, randomHex(16), SESSION_DAYS * 86400, { httpOnly: false }));
  }
  return res;
}

async function handlePassword(request, env) {
  const user = await requireUser(request, env);
  csrfCheck(request);
  await checkRateLimit(env, 'pw:' + user.id, 'password_change', 300, 3);
  const body = await readBody(request);
  const oldPw = String(body.old_password || '');
  const newPw = String(body.new_password || '');
  if (newPw.length < 8 || newPw.length > 72) throw new HttpError(400, '新密码需 8-72 位');
  const { results } = await env.DB.prepare('SELECT password_hash, salt FROM users WHERE id = ?').bind(user.id).all();
  const u = results[0];
  const oldHash = await hashPassword(oldPw, u.salt);
  if (!timingSafeEqualStr(oldHash, u.password_hash)) throw new HttpError(401, '旧密码错误');
  const salt = randomHex(16);
  const hash = await hashPassword(newPw, salt);
  await env.DB.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').bind(hash, salt, user.id).run();
  // 改密后该用户全部旧会话失效
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  return json({ ok: true });
}

/** 改登录用户名(全站生效,引用均按 user_id,无需回填)。
 *  顺序:格式 → 当前密码 → 同名幂等短路 → 占用 → 写入 + audit_log(旧名存 detail)。
 *  密码先于占用检查:避免用 409/200 差异探测某用户名是否存在(枚举口子)。 */
async function handleUsername(request, env) {
  const user = await requireUser(request, env);
  csrfCheck(request);
  await checkRateLimit(env, 'uname:' + user.id, 'username_change', 3600, 5);
  // `|| {}`:请求体字面量 `null` 时 readBody 返回 null(JSON.parse('null') 不抛,故其内部兜底不生效),
  // 直接取属性会 TypeError → 500。合同要求畸形输入一律 400(见 design.md §5)。
  const body = (await readBody(request)) || {};
  const next = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!validUsername(next)) throw new HttpError(400, '用户名需 2-20 位汉字/字母/数字/下划线/短横线');
  const { results } = await env.DB.prepare('SELECT password_hash, salt FROM users WHERE id = ?').bind(user.id).all();
  const u = results[0];
  const given = await hashPassword(password, u.salt);
  if (!timingSafeEqualStr(given, u.password_hash)) throw new HttpError(401, '密码错误');
  if (next === user.username) return json({ ok: true, username: next }); // 幂等,不留痕
  const taken = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?').bind(next, user.id).all();
  if (taken.results.length) throw new HttpError(409, '用户名已被占用');
  await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(next, user.id).run();
  await env.DB.prepare(
    'INSERT INTO audit_log (action, actor_user_id, target_user_id, detail) VALUES (?, ?, ?, ?)'
  ).bind('change_username', user.id, user.id, user.username).run();
  return json({ ok: true, username: next });
}

/** 改头像:文法三态(空串 / default:<slug> / /uploads/img-<hex>)。
 *  /uploads/… 必须存在且属于调用者(防拿别人上传的图或不存在 id 当头像)。 */
async function handleAvatar(request, env) {
  const user = await requireUser(request, env);
  csrfCheck(request);
  await checkRateLimit(env, 'uavatar:' + user.id, 'avatar_change', 3600, 30);
  const body = (await readBody(request)) || {}; // 同上:null 请求体 → 400 而非 500
  const avatar = body.avatar;
  if (typeof avatar !== 'string' ||
      !(avatar === '' || /^default:[a-z0-9-]{1,24}$/.test(avatar) || /^\/uploads\/img-[a-z0-9]+$/.test(avatar))) {
    throw new HttpError(400, '头像值无效');
  }
  if (avatar.startsWith('/uploads/')) {
    const row = await env.DB.prepare('SELECT id FROM portrait_images WHERE id = ? AND user_id = ?')
      .bind(avatar.slice('/uploads/'.length), user.id).first();
    if (!row) throw new HttpError(400, '头像值无效');
  }
  await env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(avatar, user.id).run();
  return json({ ok: true, avatar });
}

/** 审核密码门:输入 ADMIN_PASSWORD 解锁,设置 12h 的 admin_key cookie */
async function handleAdminAuth(request, env) {
  const user = await requireUser(request, env);
  csrfCheck(request);
  if (user.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  await checkRateLimit(env, 'admin:' + user.id, 'admin-auth', 600, 5);
  if (!env.ADMIN_PASSWORD) throw new HttpError(500, '服务端未配置审核密码(ADMIN_PASSWORD)');
  const body = await readBody(request);
  const given = await sha256Hex(String(body.password || '') + ':' + user.id);
  const expected = await sha256Hex(env.ADMIN_PASSWORD + ':' + user.id);
  if (!timingSafeEqualStr(given, expected)) throw new HttpError(401, '审核密码错误');
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', cookieValue(request, ADMIN_KEY_COOKIE, expected, null)); // 会话 cookie,关浏览器失效
  return res;
}
