#!/usr/bin/env node
/**
 * chrome.mjs —— 站级外壳(顶栏 / 页脚 / 主题开关)的唯一来源。
 *
 * 背景(任务 09-10-ui-design-system S5 / design.md §5):
 *   6 个 HTML 的顶栏与页脚此前各复制一份,站级改一处要手改 6 个文件。
 *   本脚本用「标记区替换」把顶栏 / 页脚收敛到一处模板:
 *
 *     <!-- chrome:nav --> ...生成内容... <!-- /chrome:nav -->
 *     <!-- chrome:foot --> ...生成内容... <!-- /chrome:foot -->
 *
 *   - 只替换标记之间的内容,标记之外的手写内容永不触碰。
 *   - 产物是**提交进仓库的静态 HTML**;本脚本是作者期工具,不进部署管线
 *     (部署仍是「推 main → Cloudflare 自动部署」,运行时就是笨静态文件)。
 *   - 用法:
 *       node scripts/chrome.mjs            # 写回 6 个 HTML(有变化才写)
 *       node scripts/chrome.mjs --check    # 只校验;漂移时退出码 1 并指出页/段
 *
 * 变体:
 *   - nav  : 6 页逐字节相同(含顶栏主题开关)。
 *   - foot : index.html = base;singer.html = base + Twemoji 署名;
 *            submit / my-submissions / profile / review 无页脚(不下发)。
 *   差异由下方 PAGES 表显式声明(单一真源),不从现有内容反推 —— 否则手改
 *   Twemoji 署名会被 --check 静默接受,漂移检测失效。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/* ------------------------------------------------------------------ *
 * 模板(唯一来源)
 * ------------------------------------------------------------------ */

const NAV = [
  '<nav class="topnav"><div class="wrap">',
  '  <a class="topnav__brand" href="/">现场档案馆</a>',
  '  <span class="topnav__links">',
  '    <a href="/submit">提交演出</a>',
  '    <a href="/my-submissions">我的提交</a>',
  '    <span id="auth-link"></span>',
  '    <button type="button" id="theme-toggle" class="theme-toggle" aria-label="切换到日间主题" aria-pressed="false" title="切换到日间主题"><svg class="theme-toggle__sun" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg><svg class="theme-toggle__moon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>',
  '  </span>',
  '</div></nav>'
].join('\n');

const FOOT_BYLINE = '    <p class="footer__byline">Made by LuanJiangXing · © 2026 现场档案馆</p>';
const FOOT_ATTRIBUTION =
  '    <p class="footer__attribution">World map: ' +
  '<a href="https://www.npmjs.com/package/@svg-maps/world" target="_blank" rel="noopener noreferrer">@svg-maps/world</a> (CC BY 4.0) · ' +
  'China boundary: ' +
  '<a href="https://datav.aliyun.com/portal/school/atlas/area_selector" target="_blank" rel="noopener noreferrer">DataV.GeoAtlas</a>' +
  '%TWEMOJI%' +
  '</p>';

const FOOT_TWEMOJI =
  ' · Reaction icons: ' +
  '<a href="https://github.com/twitter/twemoji" target="_blank" rel="noopener noreferrer">Twemoji</a> (CC BY 4.0)';

/** 页脚模板。twemoji=true 时在版权行追加 Twemoji 署名(singer 页的反应图标来源)。 */
function foot(twemoji) {
  return [
    '<footer class="site-foot" id="site-foot">',
    '  <div class="wrap">',
    FOOT_BYLINE,
    FOOT_ATTRIBUTION.replace('%TWEMOJI%', twemoji ? FOOT_TWEMOJI : ''),
    '  </div>',
    '</footer>'
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 页面 → 外壳配置(单一真源)
 *   nav  : true = 生成
 *   foot : 'base' | 'twemoji' = 生成变体;null = 该页无页脚
 * ------------------------------------------------------------------ */

const PAGES = [
  { file: 'index.html', nav: true, foot: 'base' },
  { file: 'singer.html', nav: true, foot: 'twemoji' },
  { file: 'submit.html', nav: true, foot: null },
  { file: 'my-submissions.html', nav: true, foot: null },
  { file: 'profile.html', nav: true, foot: null },
  { file: 'review.html', nav: true, foot: null }
];

const SEGMENTS = ['nav', 'foot'];

function expectedSegment(page, name) {
  if (name === 'nav') return page.nav ? NAV : null;
  if (name === 'foot') {
    if (page.foot === 'twemoji') return foot(true);
    if (page.foot === 'base') return foot(false);
    return null;
  }
  throw new Error('unknown segment: ' + name);
}

/* ------------------------------------------------------------------ *
 * 标记区读写
 * ------------------------------------------------------------------ */

function regionRe(name) {
  // 匹配 `<!-- chrome:x -->` + 任意内容 + `<!-- /chrome:x -->`。
  // 开/闭标记前后的换行各自独立可选(分组 2/4),因此**单行写法**
  // (`<!-- chrome:x -->content<!-- /chrome:x -->`)也能被检出与替换,不再依赖换行。
  // 分组:1=开标记 2=开后换行 3=内容 4=闭前换行 5=闭标记。
  return new RegExp(
    '(<!-- chrome:' + name + ' -->)(\\n?)([\\s\\S]*?)(\\n?)(<!-- /chrome:' + name + ' -->)',
    'g'
  );
}

/** 页内是否出现某段的标记 token(含只有开/闭单个标记的残缺写法)。 */
function hasMarkerToken(html, name) {
  return new RegExp('<!--\\s*\\/?chrome:' + name + '\\s*-->').test(html);
}

/** 取标记区的当前内容;未找到返回 null。 */
function readRegion(html, name) {
  const m = regionRe(name).exec(html);
  return m ? m[3] : null;
}

/** 标记区出现次数(用于检出重复标记)。 */
function countMarkers(html, name) {
  const re = regionRe(name);
  let n = 0;
  while (re.exec(html)) n++;
  return n;
}

/** 替换标记区内容,保留标记本身与其前后的换行(多行格式缩进不被破坏)。 */
function writeRegion(html, name, content) {
  return html.replace(regionRe(name), function (_all, open, nl1, _old, nl2, close) {
    return open + nl1 + content + nl2 + close;
  });
}

/* ------------------------------------------------------------------ *
 * 运行
 * ------------------------------------------------------------------ */

function firstLineDiff(expected, actual) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i++) {
    if (e[i] !== a[i]) {
      return '    期望: ' + JSON.stringify(e[i] === undefined ? '<无此行>' : e[i]) + '\n' +
             '    实际: ' + JSON.stringify(a[i] === undefined ? '<无此行>' : a[i]);
    }
  }
  return '    (内容相同但长度不同)';
}

/** 被服务的 HTML 里不得出现内联 <script>(没有 src 的脚本块)。
 *  生产 CSP 是 `script-src 'self'`(见 src/index.js 的 SECURITY_HEADERS),浏览器会**直接拒绝执行**
 *  内联脚本 —— 页面不报错、不影响其他功能,只是静默失效,是最难查的一类故障。
 *  S2 加在各页 <head> 的引导脚本(恢复主题 + 加门控 .js 类)就这样在生产上从未生效过,
 *  直到 2026-09-11 用户报「切页面主题不保持 / 放大镜与底栏不再同帧淡入」才被发现。
 *  需要首屏同步执行的引导逻辑一律放 /js/boot.js。详见 spec/frontend/quality-guidelines.md。 */
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>/;

function checkNoInlineScript() {
  const root = path.resolve(__dirname, '..');
  // 6 个静态页 + Worker 动态生成的 404 页(它的标记写在 src/index.js 的字符串里)
  const targets = PAGES.map((p) => path.join(PUBLIC_DIR, p.file))
    .concat(path.resolve(root, 'src', 'index.js'));
  let found = 0;
  for (const filePath of targets) {
    if (!fs.existsSync(filePath)) continue;
    const rel = path.relative(root, filePath);
    fs.readFileSync(filePath, 'utf8').split('\n').forEach((line, i) => {
      if (INLINE_SCRIPT_RE.test(line)) {
        console.error('[内联脚本] ' + rel + ':' + (i + 1) +
          ' —— 生产 CSP script-src \'self\' 会拒绝执行;首屏引导请放 /js/boot.js');
        found++;
      }
    });
  }
  return found;
}

function main(argv) {
  const check = argv.includes('--check');
  const unknown = argv.filter((a) => a !== '--check' && a !== '--help' && a !== '-h');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node scripts/chrome.mjs [--check]');
    return 0;
  }
  if (unknown.length) {
    console.error('未知参数: ' + unknown.join(' '));
    return 2;
  }

  let problems = 0;
  let changed = 0;

  for (const page of PAGES) {
    const filePath = path.join(PUBLIC_DIR, page.file);
    if (!fs.existsSync(filePath)) {
      console.error('[缺失] ' + page.file);
      problems++;
      continue;
    }
    let html = fs.readFileSync(filePath, 'utf8');
    const original = html;

    for (const name of SEGMENTS) {
      const expected = expectedSegment(page, name);
      const count = countMarkers(html, name);
      const actual = count === 1 ? readRegion(html, name) : null;

      if (count > 1) {
        console.error('[重复标记] ' + page.file + ' :: chrome:' + name + ' 出现 ' + count + ' 次');
        problems++;
        continue;
      }

      if (expected === null) {
        if (count === 1) {
          console.error('[多余标记] ' + page.file + ' :: chrome:' + name +
            ' 存在标记,但配置声明该页无此段(模板是唯一真源,请删除标记或改 PAGES 配置)');
          problems++;
        } else if (count === 0 && hasMarkerToken(html, name)) {
          // 残缺/畸形标记(如只有单个开或闭标记,或写法不在 regionRe 覆盖内):
          // 只要出现 chrome:<name> token 就报错,不依赖标记区可被完整匹配。
          console.error('[多余标记] ' + page.file + ' :: chrome:' + name +
            ' 残留标记 token,但配置声明该页无此段(请删除该标记)');
          problems++;
        }
        continue;
      }

      if (count === 0) {
        console.error('[缺少标记] ' + page.file + ' :: chrome:' + name + ' 未找到标记区');
        problems++;
        continue;
      }

      if (actual === expected) continue;

      if (check) {
        console.error('[漂移] ' + page.file + ' :: chrome:' + name);
        console.error(firstLineDiff(expected, actual));
        problems++;
      } else {
        html = writeRegion(html, name, expected);
      }
    }

    if (!check && html !== original) {
      fs.writeFileSync(filePath, html);
      console.log('[已生成] ' + page.file);
      changed++;
    }
  }

  if (check) {
    problems += checkNoInlineScript();
    if (problems) {
      console.error('\nchrome --check: 发现 ' + problems + ' 处漂移/错误(退出码 1)');
      return 1;
    }
    console.log('chrome --check: 6 页外壳与模板一致、无内联脚本(退出码 0)');
    return 0;
  }

  if (problems) {
    console.error('\nchrome: ' + problems + ' 处错误,未完成的写回已跳过(退出码 1)');
    return 1;
  }
  console.log(changed ? 'chrome: 已更新 ' + changed + ' 个文件' : 'chrome: 全部已是最新,无需改动');
  return 0;
}

process.exit(main(process.argv.slice(2)));
