/* singer-tag-util.js —— 歌名/标签文本小工具(前后端同式,后端见 src/tags.js tagKey)
 * key(s):NFKC(全半角折叠)→ 小写 → 去空白;只折叠 Unicode/大小写/空格差异,
 * 中文数字↔阿拉伯交给别名(后台维护,同名折叠)。 */
(function () {
  'use strict';
  function key(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFKC'); } catch (e) { /* 老引擎无 normalize,保持原样 */ }
    return t.toLowerCase().replace(/\s+/g, '');
  }
  window.TagText = { key: key };
})();
