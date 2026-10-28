/* avatars.js —— 内置默认头像表 + 头像值解析(纯函数,无 DOM 依赖)
 *
 * 头像值文法(users.avatar_url,单一真源):
 *   ''                    → 未设置:按 user.id 确定性分配一个内置默认
 *   'default:<key>'       → 用户显式选的内置默认(未知 key 优雅降级为确定性默认)
 *   '/uploads/img-<hex>'  → 站内上传图(其余任何值,含 https 外链,一律视为未设置)
 *
 * 6 个舞台主题默认头像为内联 SVG(消费 CSS 令牌,随 dark/light 变色,零第三方请求)。
 * 挂 window / globalThis:浏览器 <script> 直接用,Node 可 import 后走 globalThis.Avatars 测试。
 */
(function (root) {
  'use strict';

  var KEYS = ['ball', 'pick', 'mic', 'ticket', 'amp', 'cassette'];

  // viewBox 0 0 64 64;只用既有令牌,无颜色字面量
  var SVG = {
    ball:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
        '<rect x="28" y="5" width="8" height="5" rx="1.5" fill="var(--muted)"/>' +
        '<circle cx="32" cy="6" r="2.5" fill="var(--muted)"/>' +
        '<circle cx="32" cy="34" r="21" fill="var(--accent)"/>' +
        '<g fill="none" stroke="var(--panel-2)" stroke-width="1.5" opacity="0.85">' +
          '<path d="M32 13v42"/>' +
          '<ellipse cx="32" cy="34" rx="9" ry="21"/>' +
          '<ellipse cx="32" cy="34" rx="16" ry="21"/>' +
          '<path d="M12 27h40M12 41h40"/>' +
        '</g>' +
      '</svg>',
    pick:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
        '<path d="M32 57 C23 45 11 32 11 21 C11 12 21 7 32 7 C43 7 53 12 53 21 C53 32 41 45 32 57 Z" fill="var(--accent)"/>' +
        '<path d="M22 17 C25 13 39 13 42 17" fill="none" stroke="var(--accent-deep)" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg>',
    mic:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
        '<rect x="23" y="6" width="18" height="30" rx="9" fill="var(--accent)"/>' +
        '<g stroke="var(--panel-2)" stroke-width="1.6" opacity="0.8">' +
          '<path d="M25 15h14M25 21h14M25 27h14"/>' +
        '</g>' +
        '<rect x="28" y="33" width="8" height="15" rx="2" fill="var(--muted)"/>' +
        '<rect x="20" y="49" width="24" height="7" rx="3.5" fill="var(--accent-deep)"/>' +
      '</svg>',
    ticket:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
        '<path d="M12 16 H52 A4 4 0 0 1 56 20 V27 A5 5 0 0 0 56 37 V44 A4 4 0 0 1 52 48 H12 A4 4 0 0 1 8 44 V37 A5 5 0 0 0 8 27 V20 A4 4 0 0 1 12 16 Z" fill="var(--accent)"/>' +
        '<path d="M40 20 V44" stroke="var(--panel-2)" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round"/>' +
        '<circle cx="24" cy="32" r="6" fill="none" stroke="var(--accent-deep)" stroke-width="2.5"/>' +
      '</svg>',
    amp:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
        '<rect x="10" y="7" width="44" height="50" rx="4" fill="var(--accent)"/>' +
        '<rect x="15" y="12" width="34" height="11" rx="2" fill="var(--panel-2)"/>' +
        '<circle cx="20" cy="17.5" r="2.5" fill="var(--accent-deep)"/>' +
        '<circle cx="30" cy="17.5" r="2.5" fill="var(--accent-deep)"/>' +
        '<circle cx="40" cy="17.5" r="2.5" fill="var(--accent-deep)"/>' +
        '<circle cx="32" cy="39" r="14" fill="var(--panel-2)"/>' +
        '<circle cx="32" cy="39" r="6" fill="var(--accent-deep)"/>' +
      '</svg>',
    cassette:
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
        '<rect x="6" y="17" width="52" height="30" rx="4" fill="var(--accent)"/>' +
        '<rect x="14" y="24" width="36" height="16" rx="2" fill="var(--panel-2)"/>' +
        '<circle cx="22" cy="32" r="5.5" fill="var(--accent-deep)"/>' +
        '<circle cx="42" cy="32" r="5.5" fill="var(--accent-deep)"/>' +
        '<circle cx="22" cy="32" r="2" fill="var(--panel-2)"/>' +
        '<circle cx="42" cy="32" r="2" fill="var(--panel-2)"/>' +
      '</svg>'
  };

  /** 确定性哈希(字符码求和;模大质数避免溢出,再取模档数) */
  function defaultKeyFor(userId) {
    var s = String(userId == null ? '' : userId);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h + s.charCodeAt(i)) % 1000003;
    return KEYS[h % KEYS.length];
  }

  /** 头像值 → 渲染意图。非法/外链/未知 default key 一律降级为确定性默认 */
  function resolve(avatarUrl, userId) {
    var v = avatarUrl == null ? '' : String(avatarUrl);
    if (/^default:[a-z0-9-]{1,24}$/.test(v)) {
      var k = v.slice('default:'.length);
      return { kind: 'default', key: KEYS.indexOf(k) !== -1 ? k : defaultKeyFor(userId) };
    }
    if (/^\/uploads\/img-[a-z0-9]+$/.test(v)) return { kind: 'upload', src: v };
    return { kind: 'default', key: defaultKeyFor(userId) };
  }

  /** key → 内联 SVG 字符串(未知 key 回退首个,防御) */
  function svg(key) {
    return SVG[key] || SVG[KEYS[0]];
  }

  root.Avatars = { KEYS: KEYS, resolve: resolve, defaultKeyFor: defaultKeyFor, svg: svg };
})(typeof window !== 'undefined' ? window : globalThis);
