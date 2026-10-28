/* public/js/icons.js —— 全站矢量图标字形表与内联 SVG 生成器(参照 GeoGuide 笔法)
 *
 * 规范:
 *   - viewBox 0 0 24 24, 无填充(fill="none"), 描边走 currentColor, stroke-width 1.8, 圆头圆角
 *   - aria-hidden="true" focusable="false" 图标一律作为装饰, 外层按钮提供 title 与 aria-label
 *   - 尺寸由外层容器/CSS 控制(如 .ghost-icon-btn 默认 16x16px)
 */
(function (root) {
  'use strict';

  var ICONS = {
    // 铅笔(流线型笔尖,无橡皮接头,同 geoguide edit)
    edit: '<path d="M4.5 19.5l.9-3.6L16.2 5.1a2.1 2.1 0 0 1 3 3L8.4 18.9l-3.9.6z"/><path d="M14.6 6.7l3 3"/>',
    // 垃圾桶(无棱直桶,开盖,同 geoguide delete)
    delete: '<path d="M5 7h14M10 7V4.8h4V7M6.6 7l1 12.4a1.6 1.6 0 0 0 1.6 1.4h5.6a1.6 1.6 0 0 0 1.6-1.4L17.4 7"/>',
    // 逆时针撤销/恢复(同 geoguide restore)
    restore: '<path d="M5.6 8.4A8 8 0 1 1 4 13.6"/><path d="M4.8 3.6v5.2h5.2"/>',
    // 封禁/禁止(圆圈+斜杠)
    ban: '<circle cx="12" cy="12" r="9"/><line x1="5.7" y1="5.7" x2="18.3" y2="18.3"/>',
    // 放大镜
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>',
    // 叉号关闭
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    // 播放三角
    play: '<path d="M8 5v14l11-7z"/>',
    // 对勾
    check: '<path d="M20 6L9 17l-5-5"/>',
    // 展开/收起
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    chevronUp: '<polyline points="18 15 12 9 6 15"/>',
    // 外链
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    // 上传
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    // 右箭头
    arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    // 退出登录
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    // 分享/转发箭头 (同 geoguide share, 弧线折箭朝右)
    share: '<path d="M4 17v-1a5 5 0 0 1 5-5h8"/><polyline points="13 7 17 11 13 15"/>',
    // 置顶图钉 (线框 / 实心)
    pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
    pinFilled: '<line x1="12" y1="17" x2="12" y2="22"/><path fill="currentColor" d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
    // 警示感叹号
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    // 标签 / 别名 (标牌 + 圆孔)
    tag: '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>',
    alias: '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>'
  };

  /**
   * 生成内联 SVG 图标字符串
   * @param {string} kind 图标名称(edit | delete | restore | search | close 等)
   * @param {string} [className] 附加 CSS 类名
   * @returns {string}
   */
  function iconSvg(kind, className) {
    var paths = ICONS[kind] || kind || '';
    var cls = className ? ' class="' + className + '"' : '';
    return '<svg viewBox="0 0 24 24"' + cls + ' aria-hidden="true" focusable="false" fill="none"'
      + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + paths + '</svg>';
  }

  root.Icons = {
    get: iconSvg,
    PATHS: ICONS
  };

  /**
   * 将指定文本复制到系统剪贴板 (fallback 到隐藏 textarea)
   * @param {string} text
   * @param {function} [onSuccess]
   * @param {function} [onError]
   */
  function copyToClipboard(text, onSuccess, onError) {
    if (!text) {
      if (onError) onError(new Error('Empty text'));
      return;
    }
    if (navigator.clipboard && window.isSecureContext && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        if (onSuccess) onSuccess();
      }).catch(function () {
        execCopy();
      });
    } else {
      execCopy();
    }

    function execCopy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.style.opacity = '0';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.focus();
        if (ta.setSelectionRange) {
          ta.setSelectionRange(0, ta.value.length);
        } else {
          ta.select();
        }
        var ok = false;
        try {
          ok = document.execCommand('copy');
        } catch (e) {
          ok = false;
        }
        document.body.removeChild(ta);
        if (ok) {
          if (onSuccess) onSuccess();
        } else {
          if (onError) onError(new Error('execCommand failed'));
        }
      } catch (err) {
        if (onError) onError(err);
      }
    }
  }

  /**
   * 构造演出直达分享深链
   * @param {object} item { id, singer }
   * @returns {string} 绝对 URL
   */
  function buildPerformanceShareUrl(item) {
    if (!item || !item.id) return '';
    var singerId = item.singer;
    if (!singerId && typeof window !== 'undefined') {
      var m = window.location.pathname.match(/^\/singer\/([A-Za-z0-9_-]+)/);
      if (m) singerId = decodeURIComponent(m[1]);
    }
    singerId = singerId || 'david-tao';
    var origin = (typeof window !== 'undefined' && window.location.origin) || '';
    return origin + '/singer/' + encodeURIComponent(singerId) + '?perf=' + encodeURIComponent(item.id);
  }

  /**
   * 复制链接并带有按钮瞬时勾选反馈和 toast
   * @param {HTMLElement} btn
   * @param {string} url
   * @param {string} [msg]
   */
  function copyWithFeedback(btn, url, msg) {
    if (!url) return;
    copyToClipboard(url, function () {
      if (btn) {
        var origHtml = btn.innerHTML;
        var origTitle = btn.getAttribute('title') || '';
        btn.innerHTML = '<span style="font-size:13px;font-weight:bold;color:var(--status-approved,#2e7d32);line-height:1;">✓</span>';
        btn.setAttribute('title', '已复制链接');
        setTimeout(function () {
          btn.innerHTML = origHtml;
          if (origTitle) btn.setAttribute('title', origTitle);
          else btn.removeAttribute('title');
        }, 1200);
      }
      if (root.AppDialog && root.AppDialog.toast) {
        root.AppDialog.toast(msg || '演出链接已复制', { type: 'success' });
      }
    }, function () {
      if (root.AppDialog && root.AppDialog.toast) {
        root.AppDialog.toast('复制失败，请手动复制', { type: 'error' });
      }
    });
  }

  root.ShareUtils = {
    copyToClipboard: copyToClipboard,
    buildPerformanceShareUrl: buildPerformanceShareUrl,
    copyWithFeedback: copyWithFeedback
  };
})(typeof window !== 'undefined' ? window : globalThis);
