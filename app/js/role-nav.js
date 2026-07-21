/* ══════════════════════════════════════════════
   GLOBAL NAV MENU  —  js/role-nav.js
   Included on every page that has a #nav-dropdown. Two jobs:
     1. Mark the current page's own item active-page (no click), using
        data-nav on each item — same markup, every page, no per-page drift.
     2. Inject role-conditional items (Minu õpilased / Minu lapsed / Admin)
        after the "Kaart" item.
   Does NOT build the old top-center role-switcher tabs — removed.
   ══════════════════════════════════════════════ */

(function () {
  // Overlay-style pages (profile/notifications/settings/help): open as an
  // overlay on top of the map when possible (index.html defines
  // window.openOverlay), otherwise just navigate directly — this is what
  // already happens on standalone pages (teacher/parent/admin) and when
  // already inside another overlay page's own iframe.
  window.navOverlay = function (page) {
    if (typeof window.openOverlay === 'function') { window.openOverlay(page); }
    else { window.location = page; }
  };

  // Top-level pages (map, teacher/parent dashboards, admin): always a real
  // top-level navigation, breaking out of any overlay iframe.
  window.navTop = function (page) {
    window.top.location = page;
  };

  var dropdown = document.getElementById('nav-dropdown');
  if (!dropdown) return;

  var current = (window.location.pathname.split('/').pop() || 'index.html');

  function markActive(btn) {
    btn.classList.add('active-page');
    btn.removeAttribute('onclick');
    btn.onclick = null;
  }

  // Static items already in the page's own HTML
  dropdown.querySelectorAll('[data-nav]').forEach(function (btn) {
    if (btn.dataset.nav === current) markActive(btn);
  });

  fetch('/auth/me')
    .then(function (r) { return r.json(); })
    .then(function (user) {
      if (!user || !user.id) return;
      var role = user.role;
      var isAdmin = role === 'admin' || role === 'super_admin';

      var mapItem = dropdown.querySelector('[data-nav="index.html"]');
      var insertBefore = mapItem ? mapItem.nextSibling : null;

      function addItem(page, labelKey, fallbackLabel) {
        // admin.html has its own static "Admin" item (so it can render an icon
        // consistent with the rest of its dropdown) — don't double it up.
        if (dropdown.querySelector('[data-nav="' + page + '"]')) return;
        var btn = document.createElement('button');
        btn.className   = 'nav-dropdown-item';
        btn.dataset.nav = page;
        btn.innerHTML   = '<span data-i18n="' + labelKey + '">' + (window.t ? window.t(labelKey) : fallbackLabel) + '</span>';
        if (page === current) markActive(btn);
        else btn.addEventListener('click', function () { window.navTop(page); });
        dropdown.insertBefore(btn, insertBefore);
      }

      if (role === 'teacher' || isAdmin) addItem('teacher.html', 'teacher.my_students', 'Minu õpilased');
      if (role === 'parent'  || isAdmin) addItem('parent.html',  'parent.my_children',  'Minu lapsed');
      if (role === 'super_admin')        addItem('admin.html',   'nav.admin',           'Admin');
    })
    .catch(function () {});
}());
