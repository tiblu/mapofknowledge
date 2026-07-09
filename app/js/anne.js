/* ═══════════════════════════════════════════════════════════════
   ANNE  —  anne.js  (Map View sub-module)
   ───────────────────────────────────────────────────────────────
   Owns  : mentor chat widget — avatar, panel, open/minimize
   Calls : window.Anne.setVisible(bool)  — map-view-only scoping,
           called from learning.js / testing.js / index.html overlay
   Never : touch D3 internals, sidebar, filter panel
   ═══════════════════════════════════════════════════════════════ */

(function () {

  /* ─── DOM refs ───────────────────────────────────────────────────────── */
  var widget   = document.getElementById('anne-widget');
  var avatar   = document.getElementById('anne-avatar');
  var panel    = document.getElementById('anne-panel');
  var minimize = document.getElementById('anne-minimize');

  /* ─── Open / close ───────────────────────────────────────────────────── */
  avatar.addEventListener('click', function (e) {
    e.stopPropagation();
    panel.classList.add('open');
  });

  minimize.addEventListener('click', function (e) {
    e.stopPropagation();
    panel.classList.remove('open');
  });

  document.addEventListener('click', function (e) {
    if (!panel.contains(e.target) && e.target !== avatar) {
      panel.classList.remove('open');
    }
  });

  /* ─── Map-view-only visibility scoping ──────────────────────────────── */
  window.Anne = window.Anne || {};
  window.Anne.setVisible = function (visible) {
    widget.style.display = visible ? '' : 'none';
    if (!visible) panel.classList.remove('open');
  };

})();
