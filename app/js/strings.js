/* ══════════════════════════════════════════════
   UI STRINGS  —  js/strings.js
   ──────────────────────────────────────────────
   Loads localised UI strings from /api/strings.

   Usage:
     t('btn.learn_this')          → 'Learn this'  (or the key if not found)
     t('sidebar.your_knowledge')  → 'Your Knowledge'

   Locale resolution order:
     1. window._uiLocale (set by settings loader when ui_locale key exists)
     2. <html lang="..."> attribute
     3. 'en' default

   Strings are loaded once on page load. If the settings fetch resolves
   a different locale after initial load, call window.reloadStrings().
   ══════════════════════════════════════════════ */

(function () {

  var _strings = {};

  window.t = function (key) {
    return _strings[key] !== undefined ? _strings[key] : key;
  };

  function _applyDomSweep() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (_strings[key]) el.textContent = _strings[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      if (_strings[key]) el.placeholder = _strings[key];
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-title');
      if (_strings[key]) el.title = _strings[key];
    });
  }

  window.reloadStrings = function () {
    var locale = window._uiLocale
               || (function () { try { return localStorage.getItem('kq_ui_locale'); } catch (e) { return null; } }())
               || document.documentElement.getAttribute('lang')
               || 'et';
    fetch('/api/strings?locale=' + encodeURIComponent(locale))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        _strings = d;
        _applyDomSweep();
        if (typeof window._onStringsLoad === 'function') {
          var fn = window._onStringsLoad;
          window._onStringsLoad = null;
          fn();
        }
      })
      .catch(function () {});
  };

  window.reloadStrings();

})();
