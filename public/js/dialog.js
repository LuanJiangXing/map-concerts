/* public/js/dialog.js —— 全站自研统一弹窗与轻提示系统 (AppDialog)
 *
 * 提供一致且符合黑胶舞台夜场 / 纸白主题的无障碍交互:
 *   - AppDialog.confirm(opts | msg)  → Promise<boolean>
 *   - AppDialog.alert(opts | msg)    → Promise<void>
 *   - AppDialog.prompt(opts | msg)   → Promise<string|null>
 *   - AppDialog.toast(msg, opts)     → 悬浮轻提示(自动淡出)
 *
 * 无障碍规范:
 *   - role="dialog" aria-modal="true"
 *   - Esc 键关闭并取消
 *   - 自动聚焦首选控件, 关闭后还原此前聚焦元素
 */
(function (root) {
  'use strict';

  var prevFocused = null;
  var activeResolve = null;
  var dialogEl = null;
  var toastContainer = null;

  function ensureDialogDom() {
    if (dialogEl) return dialogEl;

    dialogEl = document.createElement('div');
    dialogEl.id = 'app-dialog';
    dialogEl.className = 'app-dialog-backdrop';
    dialogEl.setAttribute('role', 'dialog');
    dialogEl.setAttribute('aria-modal', 'true');
    dialogEl.setAttribute('aria-labelledby', 'app-dialog-title');
    dialogEl.hidden = true;

    dialogEl.innerHTML =
      '<div class="app-dialog-card">' +
        '<header class="app-dialog-head">' +
          '<h3 id="app-dialog-title" class="app-dialog-title"></h3>' +
          '<button type="button" id="app-dialog-close" class="ghost-icon-btn app-dialog-close" aria-label="关闭" title="关闭">' +
            (root.Icons ? root.Icons.get('close') : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>') +
          '</button>' +
        '</header>' +
        '<div class="app-dialog-body">' +
          '<p id="app-dialog-msg" class="app-dialog-msg"></p>' +
          '<div id="app-dialog-field" class="app-dialog-field" hidden>' +
            '<input type="text" id="app-dialog-input" class="input app-dialog-input" autocomplete="off">' +
            '<textarea id="app-dialog-textarea" class="input app-dialog-textarea" rows="3" hidden></textarea>' +
          '</div>' +
        '</div>' +
        '<footer class="app-dialog-actions">' +
          '<button type="button" id="app-dialog-cancel" class="btn btn--ghost btn--sm">取消</button>' +
          '<button type="button" id="app-dialog-confirm" class="btn btn--sm">确定</button>' +
        '</footer>' +
      '</div>';

    document.body.appendChild(dialogEl);

    var closeBtn = dialogEl.querySelector('#app-dialog-close');
    var cancelBtn = dialogEl.querySelector('#app-dialog-cancel');
    var confirmBtn = dialogEl.querySelector('#app-dialog-confirm');
    var inputEl = dialogEl.querySelector('#app-dialog-input');
    var textareaEl = dialogEl.querySelector('#app-dialog-textarea');

    function onDismiss() {
      if (activeResolve) {
        var res = activeResolve;
        activeResolve = null;
        res(dialogEl._isPrompt ? null : false);
      }
      hideDialog();
    }

    function onConfirm() {
      if (activeResolve) {
        var res = activeResolve;
        activeResolve = null;
        if (dialogEl._isPrompt) {
          var val = dialogEl._isMultiline ? textareaEl.value : inputEl.value;
          res(val);
        } else {
          res(true);
        }
      }
      hideDialog();
    }

    closeBtn.addEventListener('click', onDismiss);
    cancelBtn.addEventListener('click', onDismiss);
    confirmBtn.addEventListener('click', onConfirm);

    dialogEl.addEventListener('click', function (e) {
      if (e.target === dialogEl) onDismiss();
    });

    document.addEventListener('keydown', function (e) {
      if (dialogEl.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      } else if (e.key === 'Enter' && !dialogEl._isMultiline && (e.target === inputEl || e.target === confirmBtn)) {
        e.preventDefault();
        onConfirm();
      }
    });

    return dialogEl;
  }

  function hideDialog() {
    if (!dialogEl) return;
    dialogEl.classList.remove('is-open');
    setTimeout(function () {
      dialogEl.hidden = true;
      if (prevFocused && typeof prevFocused.focus === 'function') {
        try { prevFocused.focus(); } catch (err) {}
      }
      prevFocused = null;
    }, 150);
  }

  /**
   * 确认弹窗
   * @param {string|object} opts { title, message, confirmText, cancelText, danger }
   * @returns {Promise<boolean>}
   */
  function confirm(opts) {
    if (typeof opts === 'string') opts = { message: opts };
    opts = opts || {};

    var el = ensureDialogDom();
    prevFocused = document.activeElement;

    el._isPrompt = false;
    el._isMultiline = false;

    var titleEl = el.querySelector('#app-dialog-title');
    var msgEl = el.querySelector('#app-dialog-msg');
    var fieldEl = el.querySelector('#app-dialog-field');
    var cancelBtn = el.querySelector('#app-dialog-cancel');
    var confirmBtn = el.querySelector('#app-dialog-confirm');

    titleEl.textContent = opts.title || '确认操作';
    msgEl.textContent = opts.message || '';
    msgEl.hidden = !opts.message;
    fieldEl.hidden = true;

    cancelBtn.hidden = false;
    cancelBtn.textContent = opts.cancelText || '取消';

    confirmBtn.textContent = opts.confirmText || '确定';
    confirmBtn.className = 'btn btn--sm' + (opts.danger ? ' btn--danger-solid' : '');

    el.hidden = false;
    // 强制回流以触发过渡
    void el.offsetWidth;
    el.classList.add('is-open');

    // 聚焦确认或取消
    if (opts.danger) {
      cancelBtn.focus();
    } else {
      confirmBtn.focus();
    }

    return new Promise(function (resolve) {
      activeResolve = resolve;
    });
  }

  /**
   * 提示警告弹窗 (单个确认按钮)
   * @param {string|object} opts { title, message, okText }
   * @returns {Promise<void>}
   */
  function alert(opts) {
    if (typeof opts === 'string') opts = { message: opts };
    opts = opts || {};

    var el = ensureDialogDom();
    prevFocused = document.activeElement;

    el._isPrompt = false;
    el._isMultiline = false;

    var titleEl = el.querySelector('#app-dialog-title');
    var msgEl = el.querySelector('#app-dialog-msg');
    var fieldEl = el.querySelector('#app-dialog-field');
    var cancelBtn = el.querySelector('#app-dialog-cancel');
    var confirmBtn = el.querySelector('#app-dialog-confirm');

    titleEl.textContent = opts.title || '提示';
    msgEl.textContent = opts.message || '';
    msgEl.hidden = !opts.message;
    fieldEl.hidden = true;

    cancelBtn.hidden = true;
    confirmBtn.textContent = opts.okText || '知道了';
    confirmBtn.className = 'btn btn--sm';

    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('is-open');

    confirmBtn.focus();

    return new Promise(function (resolve) {
      activeResolve = function () { resolve(); };
    });
  }

  /**
   * 输入弹窗
   * @param {string|object} opts { title, message, defaultValue, placeholder, multiline, confirmText, cancelText, danger }
   * @returns {Promise<string|null>}
   */
  function prompt(opts) {
    if (typeof opts === 'string') opts = { message: opts };
    opts = opts || {};

    var el = ensureDialogDom();
    prevFocused = document.activeElement;

    el._isPrompt = true;
    el._isMultiline = !!opts.multiline;

    var titleEl = el.querySelector('#app-dialog-title');
    var msgEl = el.querySelector('#app-dialog-msg');
    var fieldEl = el.querySelector('#app-dialog-field');
    var inputEl = el.querySelector('#app-dialog-input');
    var textareaEl = el.querySelector('#app-dialog-textarea');
    var cancelBtn = el.querySelector('#app-dialog-cancel');
    var confirmBtn = el.querySelector('#app-dialog-confirm');

    titleEl.textContent = opts.title || '请输入';
    msgEl.textContent = opts.message || '';
    msgEl.hidden = !opts.message;
    fieldEl.hidden = false;

    if (opts.multiline) {
      inputEl.hidden = true;
      textareaEl.hidden = false;
      textareaEl.value = opts.defaultValue || '';
      textareaEl.placeholder = opts.placeholder || '';
    } else {
      inputEl.hidden = false;
      textareaEl.hidden = true;
      inputEl.value = opts.defaultValue || '';
      inputEl.placeholder = opts.placeholder || '';
    }

    cancelBtn.hidden = false;
    cancelBtn.textContent = opts.cancelText || '取消';

    confirmBtn.textContent = opts.confirmText || '确定';
    confirmBtn.className = 'btn btn--sm' + (opts.danger ? ' btn--danger-solid' : '');

    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('is-open');

    var focusTarget = opts.multiline ? textareaEl : inputEl;
    focusTarget.focus();
    if (typeof focusTarget.select === 'function') focusTarget.select();

    return new Promise(function (resolve) {
      activeResolve = resolve;
    });
  }

  /**
   * 浮动轻提示 (Toast)
   * @param {string} msg
   * @param {object} [opts] { type: 'info'|'success'|'error'|'warning', duration: 2500 }
   */
  function toast(msg, opts) {
    if (!msg) return;
    opts = opts || {};
    var type = opts.type || 'info';
    var duration = typeof opts.duration === 'number' ? opts.duration : 2500;

    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'app-toast-container';
      toastContainer.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastContainer);
    }

    var item = document.createElement('div');
    item.className = 'app-toast app-toast--' + type;

    var iconHtml = '';
    if (root.Icons) {
      if (type === 'success') iconHtml = root.Icons.get('check', 'app-toast__icon');
      else if (type === 'error') iconHtml = root.Icons.get('ban', 'app-toast__icon');
    }

    item.innerHTML = iconHtml + '<span class="app-toast__text">' + msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>';

    toastContainer.appendChild(item);

    // 触发进场动画
    void item.offsetWidth;
    item.classList.add('is-open');

    var timer = setTimeout(function () {
      dismiss();
    }, duration);

    function dismiss() {
      clearTimeout(timer);
      item.classList.remove('is-open');
      setTimeout(function () {
        if (item.parentNode) item.parentNode.removeChild(item);
      }, 200);
    }

    item.addEventListener('click', dismiss);
  }

  root.AppDialog = {
    confirm: confirm,
    alert: alert,
    prompt: prompt,
    toast: toast
  };

})(typeof window !== 'undefined' ? window : globalThis);
