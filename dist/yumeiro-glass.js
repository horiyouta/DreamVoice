/* ============================================================================
   Yumeiro Glass / ゆめいろグラス — yumeiro-glass.js v1.1.0
   ----------------------------------------------------------------------------
   Tailwind CSS 等のユーティリティフレームワークと併用する前提の、ブランド専用
   UIエンジン。yumeiro-glass.css とセットで使う。背景エンジン (vendor/bubble-bg.js,
   vendor/liquid-bg.js) と音声エンジン (vendor/bgm-audio.js, vendor/liquid-audio.js)
   は任意（読み込まれていれば自動連携する）。

   使い方の最小構成:
     <html data-yg-theme="light">
       ...
       <link rel="stylesheet" href="yumeiro-glass.css">
     </html>
     <body data-yg-root>
       ...
       <script src="yumeiro-glass.js"></script>
       <script> YumeiroGlass.init(); </script>
     </body>

   公開API（window.YumeiroGlass）:
     init(opts)
     setTheme('light'|'dark'|'toggle')
     setBGM(bool|'toggle')
     setSFX(bool|'toggle')
     notify({title, message, type, duration})
     alert(msg | {title, message, detail, icon, tone, okText})            → Promise<void>
     confirm(msg | {title, message, icon, tone, okText, cancelText})       → Promise<boolean>
     dialog({title, message, detail, icon, tone, buttons, dismissValue})   → Promise<value>
     goToPage(groupEl|selector, pageName)
     openPopover(el) / closePopover(el)
     refresh()  … 動的にDOMを追加した後に再スキャンする
   ========================================================================= */
(function (global) {
  'use strict';

  var REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var STORE_KEY_THEME = 'yg-theme';
  var STORE_KEY_BGM = 'yg-bgm';
  var STORE_KEY_SFX = 'yg-sfx';

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function on(el, ev, fn, opts) { el.addEventListener(ev, fn, opts || false); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ==========================================================================
     0. State
     ========================================================================== */
  var STATE = {
    theme: 'light',
    bgm: false,
    sfx: true,
    mobileBreakpoint: 720
  };

  /* ==========================================================================
     1. init
     ========================================================================== */
  function init(opts) {
    opts = opts || {};
    document.body.setAttribute('data-yg-root', '');

    ensureBackgroundCanvases();

    STATE.theme = opts.theme || localStorage.getItem(STORE_KEY_THEME) || 'light';
    STATE.bgm = opts.bgm !== undefined ? opts.bgm : (localStorage.getItem(STORE_KEY_BGM) === '1');
    STATE.sfx = opts.sfx !== undefined ? opts.sfx : (localStorage.getItem(STORE_KEY_SFX) !== '0');
    applyTheme(STATE.theme, /*silent*/ true);

    initLayout();
    initSidebars();
    initPopovers();
    initToastRegions();
    initPageRouter();
    initToggleChips();
    initButtons();
    initCardsFluid();
    initSelects();
    initTables();
    initAudioElements();
    initLiquidSyncClasses();

    watchGlGlass();

    document.dispatchEvent(new CustomEvent('yg:ready'));
  }

  function refresh() {
    initLayout(); initSidebars(); initPopovers(); initToastRegions();
    initPageRouter(); initToggleChips(); initButtons(); initCardsFluid(); initSelects();
    initTables(); initAudioElements(); initLiquidSyncClasses();
  }

  /* ==========================================================================
     2. Background canvases (bubble-bg.js / liquid-bg.js are optional vendors)
     ========================================================================== */
  function ensureBackgroundCanvases() {
    if (!qs('#bubbleGl')) {
      var b = document.createElement('canvas');
      b.id = 'bubbleGl'; b.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(b, document.body.firstChild);
    }
    if (!qs('#liquid')) {
      var l = document.createElement('canvas');
      l.id = 'liquid'; l.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(l, document.body.firstChild);
    }
  }

  function watchGlGlass() {
    function tick() {
      if (global.LiquidBG && global.LiquidBG.isGlassOK && global.LiquidBG.isGlassOK()) {
        document.body.classList.add('yg-gl-glass');
      } else {
        document.body.classList.remove('yg-gl-glass');
      }
      requestAnimationFrame(tick);
    }
    if (!REDUCED) requestAnimationFrame(tick);
  }

  /* ==========================================================================
     3. Theme (light / dark) — UI colors + bubble-bg.js look + body class
     ========================================================================== */
  var DARK_LOOK = { exposure: 0.025, preSat: 1.20, contrast: 1.0, lift: 0, bloom: 0 };
  /* 上記は指定値のまま。通常テキストの明るさは CSS 側の --yg-ink-soft / --yg-ink-faint（dark）で調整済み。 */
  var LIGHT_LOOK = { exposure: 0.70, preSat: 1.20, contrast: 1.25, lift: 0.03, bloom: 0.62 };

  function applyTheme(mode, silent) {
    if (mode === 'toggle') mode = (STATE.theme === 'dark') ? 'light' : 'dark';
    STATE.theme = mode;
    document.documentElement.setAttribute('data-yg-theme', mode);
    localStorage.setItem(STORE_KEY_THEME, mode);
    if (global.BubbleBG && typeof global.BubbleBG.setLook === 'function') {
      global.BubbleBG.setLook(mode === 'dark' ? DARK_LOOK : LIGHT_LOOK);
    }
    syncToggleChips('theme', mode === 'dark');
    if (!silent) document.dispatchEvent(new CustomEvent('yg:theme', { detail: { theme: mode } }));
  }

  function setTheme(mode) { applyTheme(mode); }

  /* ==========================================================================
     4. Audio (BGM loop / SFX) — wraps vendor/bgm-audio.js & vendor/liquid-audio.js
     ========================================================================== */
  function setBGM(v) {
    if (v === 'toggle') v = !STATE.bgm;
    STATE.bgm = !!v;
    localStorage.setItem(STORE_KEY_BGM, STATE.bgm ? '1' : '0');
    if (global.BGMAudio) {
      if (STATE.bgm) global.BGMAudio.start ? global.BGMAudio.start() : null;
      global.BGMAudio.duck && global.BGMAudio.duck(!STATE.bgm);
    }
    syncToggleChips('bgm', STATE.bgm);
  }
  function setSFX(v) {
    if (v === 'toggle') v = !STATE.sfx;
    STATE.sfx = !!v;
    localStorage.setItem(STORE_KEY_SFX, STATE.sfx ? '1' : '0');
    if (global.LiquidAudio && global.LiquidAudio.setEnabled) global.LiquidAudio.setEnabled(STATE.sfx);
    syncToggleChips('sfx', STATE.sfx);
  }

  function initToggleChips() {
    qsa('[data-yg-toggle]').forEach(function (el) {
      if (el.__ygWired) return; el.__ygWired = true;
      el.classList.add('yg-toggle-chip');
      var kind = el.getAttribute('data-yg-toggle');
      on(el, 'click', function () {
        if (kind === 'theme') setTheme('toggle');
        if (kind === 'bgm') setBGM('toggle');
        if (kind === 'sfx') setSFX('toggle');
      });
    });
    syncToggleChips('theme', STATE.theme === 'dark');
    syncToggleChips('bgm', STATE.bgm);
    syncToggleChips('sfx', STATE.sfx);
  }
  function syncToggleChips(kind, on_) {
    qsa('[data-yg-toggle="' + kind + '"]').forEach(function (el) {
      el.setAttribute('data-state', on_ ? 'on' : 'off');
      var label = el.querySelector('[data-yg-toggle-label]');
      if (label && el.hasAttribute('data-yg-label-on')) {
        label.textContent = on_ ? el.getAttribute('data-yg-label-on') : el.getAttribute('data-yg-label-off');
      }
    });
  }

  /* ==========================================================================
     5. Layout — [data-yg-layout] auto stack / row / center
     ========================================================================== */
  function initLayout() {
    qsa('[data-yg-layout]').forEach(function (el) {
      if (!el.hasAttribute('data-yg-center')) el.setAttribute('data-yg-center', 'true');
      if (el.__ygLayoutObs) return;
      var bp = parseInt(el.getAttribute('data-yg-breakpoint') || STATE.mobileBreakpoint, 10);
      function evaluate() {
        var isRow = el.getAttribute('data-yg-row') === 'true';
        if (!isRow) { el.removeAttribute('data-yg-mobile'); return; }
        var w = el.getBoundingClientRect().width || window.innerWidth;
        el.setAttribute('data-yg-mobile', w <= bp ? 'true' : 'false');
      }
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(evaluate);
        ro.observe(el);
        el.__ygLayoutObs = ro;
      } else {
        on(window, 'resize', evaluate, { passive: true });
      }
      evaluate();
    });
  }

  /* ==========================================================================
     6. Sidebar — [data-yg-sidebar] → hamburger + right-side drawer on mobile
     ========================================================================== */
  function initSidebars() {
    qsa('[data-yg-sidebar]').forEach(function (nav) {
      if (nav.__ygWired) return; nav.__ygWired = true;
      nav.classList.add('yg-glass');
      var menu = qs('.yg-sidebar-menu', nav) || nav;
      var innerRow = qs('.yg-sidebar-inner', nav) || nav;

      var hamburger = document.createElement('button');
      hamburger.type = 'button';
      hamburger.className = 'yg-hamburger yg-plain';
      hamburger.setAttribute('aria-label', 'メニューを開く');
      hamburger.innerHTML = '<span></span>';
      innerRow.appendChild(hamburger);

      var scrim = document.createElement('div');
      scrim.className = 'yg-scrim';
      var drawer = document.createElement('aside');
      drawer.className = 'yg-drawer yg-glass';
      drawer.appendChild(menu.cloneNode(true));
      document.body.appendChild(scrim);
      document.body.appendChild(drawer);

      // ドロワー内の複製ボタンをクリックしたら、元のボタンにも同じ動作をさせる
      qsa('button, a', drawer).forEach(function (cloneBtn, i) {
        var originals = qsa('button, a', menu);
        var original = originals[i];
        if (!original) return;
        on(cloneBtn, 'click', function (e) {
          e.preventDefault();
          original.click();
          closeDrawer();
        });
      });

      function openDrawer() {
        scrim.classList.add('is-visible');
        drawer.classList.add('is-open');
        hamburger.classList.add('is-open');
        document.documentElement.style.overflow = 'hidden';
      }
      function closeDrawer() {
        scrim.classList.remove('is-visible');
        drawer.classList.remove('is-open');
        hamburger.classList.remove('is-open');
        document.documentElement.style.overflow = '';
      }
      on(hamburger, 'click', function () {
        hamburger.classList.contains('is-open') ? closeDrawer() : openDrawer();
      });
      on(scrim, 'click', closeDrawer);
    });
  }

  /* ==========================================================================
     7. Popover / Accordion — [data-yg-trigger] + [data-yg-target]
     --------------------------------------------------------------------------
     広がるアコーディオンではなく「手前にポップアップ」。スクロールで自動的に
     閉じる（data-yg-close-on-scroll="false" で無効化可）。
     ========================================================================== */
  var openPopovers = [];

  function initPopovers() {
    qsa('[data-yg-trigger]').forEach(function (trigger) {
      if (trigger.__ygWired) return; trigger.__ygWired = true;
      var targetSel = trigger.getAttribute('data-yg-trigger');
      var target = document.querySelector(targetSel);
      if (!target) return;
      target.classList.add('yg-popover');
      if (trigger.getAttribute('data-yg-position') === 'center') target.classList.add('yg-popover-center');
      trigger.classList.add('yg-accordion-trigger');

      on(trigger, 'click', function (e) {
        e.stopPropagation();
        target.classList.contains('is-open') ? closePopover(target) : openPopover(target, trigger);
      });
    });

    if (!document.__ygPopoverGlobalWired) {
      document.__ygPopoverGlobalWired = true;
      on(document, 'click', function (e) {
        openPopovers.slice().forEach(function (p) {
          if (!p.el.contains(e.target) && p.el !== e.target && (!p.trigger || !p.trigger.contains(e.target))) {
            closePopover(p.el);
          }
        });
      });
      on(window, 'scroll', function () {
        openPopovers.slice().forEach(function (p) {
          if (p.closeOnScroll) closePopover(p.el);
        });
      }, { passive: true, capture: true });
      on(window, 'keydown', function (e) {
        if (e.key === 'Escape') openPopovers.slice().forEach(function (p) { closePopover(p.el); });
      });
    }
  }

  function openPopover(target, trigger) {
    if (target.classList.contains('yg-popover-center')) {
      // 中央表示: 位置計算不要
    } else if (trigger) {
      var r = trigger.getBoundingClientRect();
      var tw = target.offsetWidth || 260;
      var left = clamp(r.left, 12, window.innerWidth - tw - 12);
      target.style.left = left + 'px';
      target.style.top = (r.bottom + 10) + 'px';
    }
    target.classList.add('is-open');
    trigger && trigger.classList.add('is-open');
    var scrimNeeded = target.getAttribute('data-yg-scrim') !== 'false';
    var scrim = null;
    if (scrimNeeded) {
      scrim = document.createElement('div');
      scrim.className = 'yg-popover-scrim';
      document.body.appendChild(scrim);
      requestAnimationFrame(function () { scrim.classList.add('is-visible'); });
      on(scrim, 'click', function () { closePopover(target); });
      target.__ygScrim = scrim;
    }
    openPopovers.push({
      el: target, trigger: trigger,
      closeOnScroll: target.getAttribute('data-yg-close-on-scroll') !== 'false'
    });
  }

  function closePopover(target) {
    target.classList.remove('is-open');
    qsa('[data-yg-trigger]').forEach(function (t) {
      if (document.querySelector(t.getAttribute('data-yg-trigger')) === target) t.classList.remove('is-open');
    });
    if (target.__ygScrim) {
      var scrim = target.__ygScrim;
      scrim.classList.remove('is-visible');
      setTimeout(function () { scrim.remove(); }, 320);
      target.__ygScrim = null;
    }
    openPopovers = openPopovers.filter(function (p) { return p.el !== target; });
  }

  /* ==========================================================================
     8. Notification banners (toast)
     --------------------------------------------------------------------------
     PC: 右下スタック。古いものは上に押し上げられ、下端にタイマーバーが走る。
     Mobile: 中央下から出現し、最新の1件のみ表示。
     ========================================================================== */
  var toastRegions = {};

  function initToastRegions() {
    if (toastRegions.desktop) return;
    var d = document.createElement('div');
    d.className = 'yg-toast-region'; d.setAttribute('data-pos', 'desktop');
    document.body.appendChild(d);
    var m = document.createElement('div');
    m.className = 'yg-toast-region'; m.setAttribute('data-pos', 'mobile');
    document.body.appendChild(m);
    toastRegions.desktop = d;
    toastRegions.mobile = m;
  }

  function isMobileViewport() { return window.innerWidth <= 720; }

  function notify(opts) {
    opts = opts || {};
    var duration = opts.duration || 4200;
    var mobile = isMobileViewport();
    var region = mobile ? toastRegions.mobile : toastRegions.desktop;

    if (mobile) {
      // 最新の1件のみ: 既存を即座に片付ける
      qsa('.yg-toast', region).forEach(function (t) { t.remove(); });
    }

    var el = document.createElement('div');
    el.className = 'yg-toast yg-glass-strong';
    if (!mobile) el.classList.add('is-stacked');
    el.innerHTML =
      (opts.title ? '<p class="yg-toast-title">' + escapeHtml(opts.title) + '</p>' : '') +
      (opts.message ? '<p class="yg-toast-msg">' + escapeHtml(opts.message) + '</p>' : '') +
      '<button type="button" class="yg-toast-close yg-plain" aria-label="閉じる">✕</button>' +
      '<div class="yg-toast-timer"><i style="position:absolute;inset:0;background:linear-gradient(90deg,#f4b9f3,#d9c0f5 55%,#aad9f7);animation:yg-toast-shrink ' + duration + 'ms linear forwards;transform-origin:left center;display:block;"></i></div>';
    region.appendChild(el);
    requestAnimationFrame(function () {
      el.classList.add('is-shown');
      el.classList.remove('is-stacked');
    });

    var timer = setTimeout(close, duration);
    qs('.yg-toast-close', el).addEventListener('click', close);

    function close() {
      clearTimeout(timer);
      el.classList.remove('is-shown');
      setTimeout(function () { el.remove(); }, 320);
    }
    return { close: close, el: el };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ==========================================================================
     8-b. Dialog — alert / confirm / dialog（標準ダイアログの置き換え）
     --------------------------------------------------------------------------
     標準の alert() / confirm() は見た目がブランドと合わず、ブラウザ側の都合で
     出し方も変えられないため、ゆめいろグラス独自のモーダルとして用意する。
     ・すべて Promise を返す（await できる）。複数同時に呼んでも順番に1つずつ表示。
     ・Esc / 奥のスクリムをクリック = キャンセル（dismissible:false で無効化）。
     ・Tab はダイアログ内でループ。閉じたら、開く前にフォーカスしていた要素へ戻す。
     ・文字列はすべて textContent で入れるので、そのまま渡して安全（HTML は解釈されない）。
     ・message 内の改行(\n)はそのまま改行として表示される。
     ========================================================================== */
  var dialogChain = Promise.resolve();
  var dialogSeq = 0;
  var DIALOG_ICON = { 'default': '✨', danger: '🗑' };

  // 動的に作ったボタン（ダイアログ用など）が閉じたあとも流体物理の更新対象に残り続けないよう掃除する
  function pruneFluidItems() {
    FBLoop.items = FBLoop.items.filter(function (it) { return it.el.isConnected; });
  }

  function makeEl(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function showDialog(opts) {
    return new Promise(function (resolve) {
      var tone = opts.tone === 'danger' ? 'danger' : 'default';
      var buttons = (opts.buttons && opts.buttons.length) ? opts.buttons : [{ label: 'OK', value: true }];
      var dismissible = opts.dismissible !== false;
      var dismissValue = opts.dismissValue === undefined ? null : opts.dismissValue;
      var opener = document.activeElement;
      var uid = 'yg-dialog-' + (++dialogSeq);
      var done = false;

      var layer = makeEl('div', 'yg-dialog-layer');
      var scrim = makeEl('div', 'yg-dialog-scrim');
      var box = makeEl('div', 'yg-dialog' + (tone === 'danger' ? ' yg-dialog-danger' : ''));
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      box.tabIndex = -1;

      var icon = opts.icon === undefined ? DIALOG_ICON[tone] : opts.icon;
      if (icon) { var ic = makeEl('div', 'yg-dialog-icon', icon); ic.setAttribute('aria-hidden', 'true'); box.appendChild(ic); }
      if (opts.title) { var t = makeEl('h2', 'yg-dialog-title', opts.title); t.id = uid + '-title'; box.appendChild(t); box.setAttribute('aria-labelledby', t.id); }
      if (opts.message) { var m = makeEl('p', 'yg-dialog-msg', opts.message); m.id = uid + '-msg'; box.appendChild(m); box.setAttribute('aria-describedby', m.id); }
      if (opts.detail) box.appendChild(makeEl('div', 'yg-dialog-detail yg-selectable', opts.detail));

      var actions = makeEl('div', 'yg-dialog-actions');
      var focusIndex = -1;
      var btnEls = buttons.map(function (b, i) {
        var btn = makeEl('button', 'yg-dialog-btn' +
          (b.variant === 'secondary' ? ' is-secondary' : b.variant === 'danger' ? ' is-danger' : ''), b.label);
        btn.type = 'button';
        if (b.autofocus && focusIndex < 0) focusIndex = i;
        on(btn, 'click', function () { finish(b.value); });
        actions.appendChild(btn);
        return btn;
      });
      if (focusIndex < 0) focusIndex = btnEls.length - 1;   // 慣例: 主ボタンは一番最後に置く
      box.appendChild(actions);
      layer.appendChild(scrim);
      layer.appendChild(box);

      function onKey(e) {
        if (e.key === 'Escape' && dismissible) {
          e.preventDefault(); e.stopPropagation();   // 奥のポップオーバーまで一緒に閉じないように
          finish(dismissValue);
        } else if (e.key === 'Tab') {
          var first = btnEls[0], last = btnEls[btnEls.length - 1], act = document.activeElement;
          if (!box.contains(act)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
          else if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
        }
      }
      // 奥のページがスクロールしないように。ただし、長いメッセージ自体はスクロールできる
      function blockScroll(e) {
        var msg = e.target.closest && e.target.closest('.yg-dialog-msg, .yg-dialog-detail');
        if (msg && msg.scrollHeight > msg.clientHeight) return;
        e.preventDefault();
      }

      function finish(value) {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        layer.classList.remove('is-open');
        setTimeout(function () { layer.remove(); pruneFluidItems(); }, 400);
        if (opener && opener.focus && document.contains(opener)) {
          try { opener.focus({ preventScroll: true }); } catch (err) { /* noop */ }
        }
        resolve(value);
      }

      if (dismissible) on(scrim, 'click', function () { finish(dismissValue); });
      on(layer, 'wheel', blockScroll, { passive: false });
      on(layer, 'touchmove', blockScroll, { passive: false });
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(layer);
      initButtons();   // 動的に作ったボタンにも流体物理を付与
      btnEls[focusIndex].focus({ preventScroll: true });
      requestAnimationFrame(function () { requestAnimationFrame(function () { layer.classList.add('is-open'); }); });
    });
  }

  /* dialog(opts) → Promise<選ばれたボタンの value>
     opts.buttons: [{ label, value, variant: 'primary'(既定)|'secondary'|'danger', autofocus }]
                   主ボタンは最後に置く（最後のボタンに初期フォーカス。autofocus で変更可）
     opts.dismissValue: Esc・スクリムのクリックで閉じたときの値（既定 null）
     opts.icon: 絵文字（''で非表示）/ opts.tone: 'default' | 'danger' */
  function dialog(opts) {
    var run = dialogChain.then(function () { return showDialog(opts || {}); });
    dialogChain = run.catch(function () { /* 1つの失敗で後続の表示を止めない */ });
    return run;
  }

  function normalizeDialogOpts(o) {
    return (typeof o === 'string') ? { message: o } : (o || {});
  }

  /* alert(文字列 | opts) → Promise<void> */
  function alertDialog(o) {
    o = normalizeDialogOpts(o);
    return dialog({
      title: o.title, message: o.message, detail: o.detail, icon: o.icon, tone: o.tone,
      buttons: [{ label: o.okText || 'OK', value: true }],
      dismissValue: true
    }).then(function () { /* 値なし */ });
  }

  /* confirm(文字列 | opts) → Promise<boolean>
     tone:'danger' のときは OK ボタンが注意色になり、誤操作を避けるためキャンセルに初期フォーカスする */
  function confirmDialog(o) {
    o = normalizeDialogOpts(o);
    var danger = o.tone === 'danger';
    return dialog({
      title: o.title, message: o.message, detail: o.detail, icon: o.icon, tone: o.tone,
      buttons: [
        { label: o.cancelText || 'キャンセル', value: false, variant: 'secondary', autofocus: danger },
        { label: o.okText || 'OK', value: true, variant: danger ? 'danger' : 'primary' }
      ],
      dismissValue: false
    }).then(function (v) { return v === true; });
  }

  /* ==========================================================================
     9. Sub-page router — [data-yg-page-group] + [data-yg-page] + [data-yg-page-link]
     ========================================================================== */
  function initPageRouter() {
    qsa('[data-yg-page-group]').forEach(function (group) {
      if (group.__ygWired) return; group.__ygWired = true;
      var pages = qsa('[data-yg-page]', group);
      var initial = group.getAttribute('data-yg-initial-page') || (pages[0] && pages[0].getAttribute('data-yg-page'));
      showPage(group, initial);

      var links = qsa('[data-yg-page-link]').filter(function (l) {
        var g = l.getAttribute('data-yg-page-group');
        return !g || document.querySelector(g) === group;
      });
      links.forEach(function (link) {
        on(link, 'click', function (e) {
          if (link.tagName === 'A') e.preventDefault();
          goToPage(group, link.getAttribute('data-yg-page-link'));
        });
      });
    });
  }
  function showPage(group, name) {
    qsa('[data-yg-page]', group).forEach(function (p) {
      p.classList.toggle('is-active', p.getAttribute('data-yg-page') === name);
    });
    qsa('[data-yg-page-link]').forEach(function (l) {
      var g = l.getAttribute('data-yg-page-group');
      if (g && document.querySelector(g) !== group) return;
      l.classList.toggle('is-active', l.getAttribute('data-yg-page-link') === name);
    });
  }
  function goToPage(groupRef, name) {
    var group = typeof groupRef === 'string' ? document.querySelector(groupRef) : groupRef;
    if (!group) return;
    showPage(group, name);
    syncLiquidAfterPageChange();
    document.dispatchEvent(new CustomEvent('yg:page', { detail: { group: group, page: name } }));
  }
  // ページ切替直後は、直前まで display:none だった要素の位置(rect)が確定していないため、
  // レイアウト確定後に liquid-bg.js 側へ位置の再計算を依頼する（ガラス/フロートの表示ズレ対策）。
  function syncLiquidAfterPageChange() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        initLiquidSyncClasses();
        if (global.LiquidBG && typeof global.LiquidBG.refresh === 'function') {
          global.LiquidBG.refresh();
        }
      });
    });
  }

  /* ==========================================================================
     10. div: liquid sync helper classes → data-float / data-glass
     --------------------------------------------------------------------------
     .yg-liquid-float  → [data-float] を付与（liquid-bg.js のビート板物理に乗る）
     .yg-liquid-glass  → [data-glass] を付与（liquid-bg.js の本物ガラス屈折に乗る）
     どちらも独立してON/OFFできる。liquid-bg.js が無い環境向けにフォールバック
     のCSSアニメーションも yumeiro-glass.css 側に用意してある。
     ========================================================================== */
  function initLiquidSyncClasses() {
    var changed = false;
    qsa('.yg-liquid-float').forEach(function (el) {
      if (!el.hasAttribute('data-float')) { el.setAttribute('data-float', ''); changed = true; }
      el.setAttribute('data-yg-float', '');
      if (!global.LiquidBG || !global.LiquidBG.ready) el.classList.add('yg-float-fallback');
    });
    qsa('.yg-liquid-glass').forEach(function (el) {
      if (!el.hasAttribute('data-glass')) { el.setAttribute('data-glass', ''); changed = true; }
      el.setAttribute('data-yg-glass-sync', '');
    });
    if (changed && global.LiquidBG && typeof global.LiquidBG.refresh === 'function') {
      global.LiquidBG.refresh();
    }
  }

  /* ==========================================================================
     11. button / card: fluid physics (ported from fluid-button.html)
     --------------------------------------------------------------------------
     半陰的オイラー法によるバネ+粘性の連続ソルバ。ホバー/プレスで q が目標値へ
     近づき、毛細管波モードが角の丸みを揺らす。ボタン用とカード用で別プロファイルを
     使い分ける: ボタンは最大変化量を抑えめに、カードはボタンより速く・小さく揺れる
     ように調整してある。
     ========================================================================== */
  var FB_P_BUTTON = {
    H: 1 / 240, MAXSUB: 14, DT_CAP: 0.05,
    W0: 19.0, ZETA: 0.42, BETA: 20.0, ALPHA: 70.0,
    Q_HOVER: 0.032, Q_PRESS: -0.020, QMAX: 0.065,
    AG_GAIN: 0.8, AG_TAU: 0.38, AG_NU: 2.0, AG_MAX: 3.0,
    STRETCH: 0.14, STRETCH_TAU: 0.05,
    CAP: 120, NUK: 2.6, TRIAD: 1.8, RMAX: 0.13, R0: 16,
    OU_TAU: 0.12, OU_HOVER: 70, OU_IDLE: 16,
    ADV: 13.0
  };
  /* カード用: ボタンより自然振動数(W0)を高く・減衰(ZETA/BETA)を強くして素早く収束させ、
     振幅(QMAX/RMAX)とノイズ(OU_*)を小さく抑えることで「速いけれど控えめ」な揺れにする。 */
  var FB_P_CARD = {
    H: 1 / 240, MAXSUB: 14, DT_CAP: 0.05,
    W0: 34.0, ZETA: 0.55, BETA: 40.0, ALPHA: 60.0,
    Q_HOVER: 0.030, Q_PRESS: -0.020, QMAX: 0.05,
    AG_GAIN: 0.8, AG_TAU: 0.22, AG_NU: 2.0, AG_MAX: 3.0,
    STRETCH: 0.10, STRETCH_TAU: 0.035,
    CAP: 260, NUK: 3.4, TRIAD: 1.6, RMAX: 0.10, R0: 16,
    OU_TAU: 0.08, OU_HOVER: 55, OU_IDLE: 12,
    ADV: 20.0
  };
  var fbGaussSpare = null;
  function fbGauss() {
    if (fbGaussSpare !== null) { var s = fbGaussSpare; fbGaussSpare = null; return s; }
    var u, v, s2;
    do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s2 = u * u + v * v; } while (s2 === 0 || s2 >= 1);
    var m = Math.sqrt(-2 * Math.log(s2) / s2);
    fbGaussSpare = v * m; return u * m;
  }

  function FluidButton(el, params) {
    this.P = params || FB_P_BUTTON;
    this.el = el;
    this.label = qs('.yg-btn-label', el);
    this.q = 0; this.v = 0; this.target = 0;
    this.e = 0; this.agit = 0;
    this.px = 0.5; this.py = 0.5; this.gx = 0.5; this.gy = 0.5;
    this.hover = false; this.press = false; this.awake = false; this.acc = 0;
    /* 静止時の角丸は要素自身の CSS 値を基準にする（ボタン=16px, カード=22px など
       トークンが変わっても一致するように、固定値ではなく実測する） */
    var cs = getComputedStyle(el);
    var r0 = parseFloat(cs.borderTopLeftRadius);
    this.R0 = (isFinite(r0) && r0 > 0) ? r0 : this.P.R0;
    var self = this;
    this.modes = [2, 3, 4].map(function (n) {
      return { n: n, w: Math.sqrt(self.P.CAP * n * n * n), g: self.P.NUK * n * n, a: 0, ad: 0, ou: 0 };
    });
    this.bind();
    this.render();
  }
  FluidButton.prototype.bind = function () {
    var self = this;
    function setPos(e) {
      var r = self.el.getBoundingClientRect();
      self.px = clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
      self.py = clamp((e.clientY - r.top) / (r.height || 1), 0, 1);
    }
    on(this.el, 'pointerenter', function (e) { self.hover = true; setPos(e); self.wake(); });
    on(this.el, 'pointermove', function (e) { setPos(e); });
    on(this.el, 'pointerleave', function () { self.hover = false; self.press = false; self.wake(); });
    on(this.el, 'pointerdown', function (e) { self.press = true; setPos(e); self.wake(); });
    on(this.el, 'pointerup', function () { self.press = false; self.wake(); });
    on(this.el, 'pointercancel', function () { self.press = false; self.wake(); });
  };
  FluidButton.prototype.wake = function () { this.awake = true; FBLoop.start(); };
  FluidButton.prototype.step = function (h) {
    var P = this.P, nuMul = 1 + P.AG_NU * this.agit;
    this.target = this.hover ? (this.press ? P.Q_PRESS : P.Q_HOVER) : 0;
    var d = this.q - this.target, k = P.W0 * P.W0;
    var acc = -k * d * (1 + P.ALPHA * d * d) - 2 * P.ZETA * P.W0 * nuMul * this.v - P.BETA * this.v * Math.abs(this.v);
    this.v = clamp(this.v + acc * h, -6, 6);
    this.q += this.v * h;
    var eT = P.STRETCH * Math.tanh(this.v * 1.1);
    this.e += (eT - this.e) * (1 - Math.exp(-h / P.STRETCH_TAU));
    var ouAmp = this.hover ? P.OU_HOVER : P.OU_IDLE;
    for (var i = 0; i < this.modes.length; i++) {
      var md = this.modes[i];
      md.ou += (-md.ou * h / P.OU_TAU) + fbGauss() * ouAmp * Math.sqrt(h);
      var F = md.ou;
      if (i > 0) { var lo = this.modes[i - 1]; F += P.TRIAD * lo.a * lo.ad * md.w; }
      var a2 = -md.w * md.w * md.a - 2 * md.g * nuMul * md.ad + F;
      md.ad = clamp(md.ad + a2 * h, -40, 40);
      md.a = clamp(md.a + md.ad * h, -P.RMAX, P.RMAX);
    }
    var r = 1 - Math.exp(-h * P.ADV);
    this.gx += (this.px - this.gx) * r; this.gy += (this.py - this.gy) * r;
    this.agit -= this.agit * h / P.AG_TAU; if (this.agit < 1e-4) this.agit = 0;
  };
  FluidButton.prototype.render = function () {
    var P = this.P;
    var s = 1 + P.QMAX * Math.tanh(this.q / P.QMAX);
    var e = this.e, sx = s * Math.exp(e), sy = s * Math.exp(-e);
    this.el.style.transform = 'scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
    if (this.label) this.label.style.transform = 'scale(' + Math.exp(-e * 0.6).toFixed(4) + ',' + Math.exp(e * 0.6).toFixed(4) + ')';
    var R = this.R0, th = [2.356, 0.785, -0.785, -2.356], rx = [], ry = [];
    for (var i = 0; i < 4; i++) {
      var dA = 0, dB = 0;
      for (var j = 0; j < this.modes.length; j++) {
        var md = this.modes[j];
        dA += md.a * Math.cos(md.n * (th[i] - 0.35));
        dB += md.a * Math.cos(md.n * (th[i] + 0.35));
      }
      rx.push(clamp(R * (1 + dA) / sx, 4, 40).toFixed(2));
      ry.push(clamp(R * (1 + dB) / sy, 4, 40).toFixed(2));
    }
    this.el.style.borderRadius = rx.join('px ') + 'px / ' + ry.join('px ') + 'px';
    var glow = clamp(Math.abs(this.v) * 0.22 + (this.hover ? 0.55 : 0), 0, 1);
    this.el.style.setProperty('--yg-glow', glow.toFixed(3));
    this.el.style.setProperty('--yg-gx', (this.gx * 100).toFixed(1) + '%');
    this.el.style.setProperty('--yg-gy', (this.gy * 100).toFixed(1) + '%');
  };
  FluidButton.prototype.settled = function () {
    if (this.hover || this.press) return false;
    if (Math.abs(this.q - this.target) > 2e-4 || Math.abs(this.v) > 2e-3) return false;
    if (Math.abs(this.e) > 1e-4 || this.agit > 0.01) return false;
    for (var i = 0; i < this.modes.length; i++) if (Math.abs(this.modes[i].a) > 6e-4) return false;
    return true;
  };
  FluidButton.prototype.rest = function () {
    this.q = this.target; this.v = 0; this.e = 0; this.agit = 0;
    this.modes.forEach(function (m) { m.a = 0; m.ad = 0; m.ou = 0; });
    this.render();
  };
  FluidButton.prototype.advance = function (dt) {
    if (REDUCED) {
      this.target = this.hover ? (this.press ? this.P.Q_PRESS : this.P.Q_HOVER) : 0;
      this.q += (this.target - this.q) * (1 - Math.exp(-dt * 12));
      this.render(); this.awake = Math.abs(this.q - this.target) > 1e-4; return;
    }
    this.acc += dt; var n = 0;
    while (this.acc >= this.P.H && n < this.P.MAXSUB) { this.step(this.P.H); this.acc -= this.P.H; n++; }
    if (n >= this.P.MAXSUB) this.acc = 0;
    this.render();
    if (this.settled()) { this.rest(); this.awake = false; }
  };

  var FBLoop = {
    items: [], running: false, last: 0,
    add: function (x) { this.items.push(x); },
    start: function () {
      if (this.running) return; this.running = true; this.last = performance.now();
      requestAnimationFrame(FBLoop.tick);
    },
    tick: function (now) {
      var dt = Math.min((now - FBLoop.last) / 1000, 0.05);
      FBLoop.last = now;
      var alive = false;
      FBLoop.items.forEach(function (it) { if (it.awake) { it.advance(dt); alive = alive || it.awake; } });
      if (alive) requestAnimationFrame(FBLoop.tick); else FBLoop.running = false;
    }
  };

  function initButtons() {
    var sel = 'button:not(.yg-plain):not(.yg-icon-btn):not(.yg-nav-btn):not(.yg-toggle-chip):not(.yg-select-trigger):not(.yg-audio-play):not(.yg-hamburger):not(.yg-toast-close):not([data-yg-no-physics]), .yg-btn:not(.yg-plain):not([data-yg-no-physics])';
    qsa(sel).forEach(function (btn) {
      if (btn.__ygFluid) return; btn.__ygFluid = true;
      if (!qs('.yg-btn-sheen', btn)) {
        var sheen = document.createElement('span');
        sheen.className = 'yg-btn-sheen';
        btn.insertBefore(sheen, btn.firstChild);
      }
      if (!qs('.yg-btn-label', btn)) {
        var label = document.createElement('span');
        label.className = 'yg-btn-label';
        while (btn.childNodes.length > 1) label.appendChild(btn.childNodes[1] === btn.firstChild ? btn.childNodes[1] : btn.childNodes[btn.childNodes.length - 1]);
        // 上のループは sheen 以外の子要素を label に集約する
        Array.prototype.slice.call(btn.childNodes).forEach(function (node) {
          if (node !== qs('.yg-btn-sheen', btn) && node !== label) label.appendChild(node);
        });
        btn.appendChild(label);
      }
      var fb = new FluidButton(btn, FB_P_BUTTON);
      FBLoop.add(fb);
    });
  }

  /* ==========================================================================
     11-b. card hover: same solver as buttons, tuned faster & subtler
     --------------------------------------------------------------------------
     .yg-glass-hover にホバー/プレスで反応する流体物理を付与する。ボタンより
     自然振動数を高く・減衰を強く・振幅を小さくしてあるので、素早く小さく
     「ぷるっ」と反応してすぐ落ち着く。sheen/label のラップは行わない
     （カードは装飾を持たないシンプルな div のため）。
     ========================================================================== */
  function initCardsFluid() {
    qsa('.yg-glass-hover:not([data-yg-no-physics])').forEach(function (card) {
      if (card.__ygFluidCard) return; card.__ygFluidCard = true;
      var fb = new FluidButton(card, FB_P_CARD);
      FBLoop.add(fb);
    });
  }

  // Node.addEventListener で複数イベントをまとめて登録するための小さなポリフィル的ヘルパー
  var _origOn = on;
  on = function (el, ev, fn, opts) {
    if (Array.isArray(ev)) { ev.forEach(function (e) { el.addEventListener(e, fn, opts || false); }); return; }
    _origOn(el, ev, fn, opts);
  };

  /* ==========================================================================
     12. select: glass "slot reel" custom dropdown
     ========================================================================== */
  function initSelects() {
    qsa('select:not(.yg-plain)').forEach(function (native) {
      if (native.__ygWired) return; native.__ygWired = true;
      native.classList.add('yg-plain');

      var wrap = document.createElement('div');
      wrap.className = 'yg-select';
      native.parentNode.insertBefore(wrap, native);
      wrap.appendChild(native);

      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'yg-select-trigger yg-plain';
      trigger.innerHTML = '<span class="yg-select-value"></span><span class="yg-chevron">▾</span>';
      wrap.appendChild(trigger);

      var reel = document.createElement('div');
      reel.className = 'yg-select-reel';
      wrap.appendChild(reel);

      function buildOptions() {
        reel.innerHTML = '';
        qsa('option', native).forEach(function (opt) {
          var item = document.createElement('div');
          item.className = 'yg-select-option' + (opt.selected ? ' is-selected' : '');
          item.textContent = opt.textContent;
          item.setAttribute('data-value', opt.value);
          on(item, 'click', function () {
            native.value = opt.value;
            native.dispatchEvent(new Event('change', { bubbles: true }));
            syncTrigger();
            qsa('.yg-select-option', reel).forEach(function (o) { o.classList.toggle('is-selected', o === item); });
            closeReel();
          });
          reel.appendChild(item);
        });
      }
      function syncTrigger() {
        var opt = native.options[native.selectedIndex];
        qs('.yg-select-value', trigger).textContent = opt ? opt.textContent : '';
      }

      function openReel() { wrap.classList.add('is-open'); }
      function closeReel() { wrap.classList.remove('is-open'); }
      on(trigger, 'click', function (e) {
        e.stopPropagation();
        wrap.classList.contains('is-open') ? closeReel() : openReel();
      });
      on(document, 'click', function (e) { if (!wrap.contains(e.target)) closeReel(); });

      var mo = new MutationObserver(buildOptions);
      mo.observe(native, { childList: true, subtree: true });

      buildOptions(); syncTrigger();
    });
  }

  /* ==========================================================================
     13. table: Excel-like selection + keyboard navigation
     ========================================================================== */
  function initTables() {
    qsa('table:not(.yg-plain)').forEach(function (table) {
      if (table.__ygWired) return; table.__ygWired = true;
      table.classList.add('yg-table');
      if (!table.parentElement.classList.contains('yg-table-wrap')) {
        var wrap = document.createElement('div');
        wrap.className = 'yg-table-wrap';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
      }
      var cells = qsa('tbody td', table);
      cells.forEach(function (cell) { cell.tabIndex = 0; });

      var selected = null;
      function select(cell) {
        if (selected) selected.classList.remove('is-selected');
        selected = cell; if (selected) { selected.classList.add('is-selected'); selected.focus(); }
      }
      cells.forEach(function (cell) {
        on(cell, 'click', function () { select(cell); });
        on(cell, 'dblclick', function () { enterEdit(cell); });
        on(cell, 'keydown', function (e) {
          var row = cell.parentElement, rows = qsa('tr', table.querySelector('tbody'));
          var rIdx = rows.indexOf(row), cIdx = qsa('td', row).indexOf(cell);
          var map = { ArrowRight: [rIdx, cIdx + 1], ArrowLeft: [rIdx, cIdx - 1], ArrowDown: [rIdx + 1, cIdx], ArrowUp: [rIdx - 1, cIdx] };
          if (map[e.key]) {
            e.preventDefault();
            var target = rows[map[e.key][0]] && qsa('td', rows[map[e.key][0]])[map[e.key][1]];
            if (target) select(target);
          } else if (e.key === 'Enter') { e.preventDefault(); enterEdit(cell); }
        });
      });
      function enterEdit(cell) {
        cell.setAttribute('contenteditable', 'true');
        cell.focus();
        var range = document.createRange(); range.selectNodeContents(cell);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        function commit() { cell.removeAttribute('contenteditable'); cell.removeEventListener('blur', commit); }
        on(cell, 'blur', commit);
        on(cell, 'keydown', function ke(e) { if (e.key === 'Enter') { e.preventDefault(); cell.blur(); } });
      }
    });
  }

  /* ==========================================================================
     14. audio: custom glass player + persistent mini dock
     ========================================================================== */
  var audioDock = null;
  function ensureDock() {
    if (audioDock) return audioDock;
    audioDock = document.createElement('div');
    audioDock.className = 'yg-audio-dock';
    audioDock.innerHTML =
      '<button type="button" class="yg-audio-play yg-plain" aria-label="再生/一時停止"><span class="yg-dock-icon">▶</span></button>' +
      '<div class="yg-audio-body"><p class="yg-audio-title"></p>' +
      '<div class="yg-audio-bar"><div class="yg-audio-bar-fill"></div></div></div>';
    document.body.appendChild(audioDock);
    return audioDock;
  }

  function initAudioElements() {
    qsa('audio:not(.yg-plain)').forEach(function (native) {
      if (native.__ygWired) return; native.__ygWired = true;
      native.classList.add('yg-native-hidden', 'yg-plain');
      var title = native.getAttribute('data-yg-title') || native.getAttribute('title') || (native.currentSrc || native.src || 'Audio').split('/').pop();
      var useDock = native.getAttribute('data-yg-mini-player') !== 'false';

      var ui = document.createElement('div');
      ui.className = 'yg-audio';
      ui.innerHTML =
        '<button type="button" class="yg-audio-play yg-plain" aria-label="再生/一時停止">' +
        '<span class="yg-play-icon">▶</span></button>' +
        '<div class="yg-audio-body">' +
        '<p class="yg-audio-title">' + escapeHtml(title) + '</p>' +
        '<div class="yg-audio-bar"><div class="yg-audio-bar-fill"></div></div>' +
        '<p class="yg-audio-time">0:00 / 0:00</p>' +
        '</div>';
      native.parentNode.insertBefore(ui, native.nextSibling);

      var playBtn = qs('.yg-audio-play', ui);
      var bar = qs('.yg-audio-bar', ui);
      var fill = qs('.yg-audio-bar-fill', ui);
      var timeEl = qs('.yg-audio-time', ui);
      var icon = qs('.yg-play-icon', ui);

      function fmt(t) { t = t || 0; var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
      function updateUI() {
        var pct = native.duration ? (native.currentTime / native.duration) * 100 : 0;
        fill.style.width = pct + '%';
        timeEl.textContent = fmt(native.currentTime) + ' / ' + fmt(native.duration);
        icon.textContent = native.paused ? '▶' : '❚❚';
        if (useDock) {
          var dock = ensureDock();
          if (!native.paused) {
            dock.classList.add('is-visible');
            qs('.yg-audio-title', dock).textContent = title;
            qs('.yg-audio-bar-fill', dock).style.width = pct + '%';
            qs('.yg-dock-icon', dock).textContent = native.paused ? '▶' : '❚❚';
            dock.__ygNative = native;
          } else if (dock.__ygNative === native) {
            dock.classList.remove('is-visible');
          }
        }
      }
      on(playBtn, 'click', function () { native.paused ? native.play() : native.pause(); });
      on(bar, 'click', function (e) {
        var r = bar.getBoundingClientRect();
        native.currentTime = ((e.clientX - r.left) / r.width) * (native.duration || 0);
      });
      on(native, ['play', 'pause', 'timeupdate', 'loadedmetadata'], updateUI);

      if (useDock) {
        var dock = ensureDock();
        on(qs('.yg-audio-play', dock), 'click', function () {
          if (dock.__ygNative) dock.__ygNative.paused ? dock.__ygNative.play() : dock.__ygNative.pause();
        });
      }
      updateUI();
    });
  }

  /* ==========================================================================
     Public API
     ========================================================================== */
  global.YumeiroGlass = {
    init: init,
    refresh: refresh,
    setTheme: setTheme,
    setBGM: setBGM,
    setSFX: setSFX,
    notify: notify,
    alert: alertDialog,
    confirm: confirmDialog,
    dialog: dialog,
    goToPage: goToPage,
    openPopover: openPopover,
    closePopover: closePopover,
    state: STATE
  };
})(window);