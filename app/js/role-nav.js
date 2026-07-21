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

      var ICONS = {
        'teacher.html': '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
          + '<path d="M7.5 3.2 13 5.5 7.5 7.8 2 5.5 7.5 3.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
          + '<path d="M4.7 6.6v2.6c0 .9 1.3 1.6 2.8 1.6s2.8-.7 2.8-1.6V6.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'
          + '<path d="M13 5.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
          + '</svg>',
        'parent.html': '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
          + '<circle cx="5.2" cy="4" r="1.9" stroke="currentColor" stroke-width="1.2"/>'
          + '<path d="M1.7 12c0-2 1.6-3.2 3.5-3.2s3.5 1.2 3.5 3.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
          + '<circle cx="11.2" cy="6.5" r="1.3" stroke="currentColor" stroke-width="1.1"/>'
          + '<path d="M8.9 12.3c0-1.5 1-2.4 2.3-2.4s2.3.9 2.3 2.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>'
          + '</svg>',
        'admin.html': '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
          + '<rect x="1.5" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>'
          + '<path d="M5 3V2M10 3V2M1.5 6.5h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
          + '</svg>',
      };

      function addItem(page, labelKey, fallbackLabel) {
        // admin.html has its own static "Admin" item (so it can render an icon
        // consistent with the rest of its dropdown) — don't double it up.
        if (dropdown.querySelector('[data-nav="' + page + '"]')) return;
        var btn = document.createElement('button');
        btn.className   = 'nav-dropdown-item';
        btn.dataset.nav = page;
        btn.innerHTML   = (ICONS[page] || '') + '<span data-i18n="' + labelKey + '">' + (window.t ? window.t(labelKey) : fallbackLabel) + '</span>';
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
