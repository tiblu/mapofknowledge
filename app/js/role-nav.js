/* ══════════════════════════════════════════════
   ADMIN NAV ITEM  —  js/role-nav.js
   Included on every page that has a #nav-dropdown. Injects an "Admin"
   burger-menu item, visible only to super_admin users. admin.html is a
   standalone top-level page (not an overlay), so navigation always targets
   window.top even when this script runs inside an overlay iframe
   (profile/notifications/settings).
   ══════════════════════════════════════════════ */

(function () {
  var dropdown = document.getElementById('nav-dropdown');
  if (!dropdown) return;

  fetch('/auth/me')
    .then(function (r) { return r.json(); })
    .then(function (user) {
      if (!user || user.role !== 'super_admin') return;
      if (dropdown.querySelector('[data-nav="admin.html"]')) return;

      var btn = document.createElement('button');
      btn.className = 'nav-dropdown-item';
      btn.dataset.nav = 'admin.html';
      btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
        + '<rect x="1.5" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>'
        + '<path d="M5 3V2M10 3V2M1.5 6.5h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
        + '</svg>'
        + '<span data-i18n="nav.admin">' + (window.t ? window.t('nav.admin') : 'Admin') + '</span>';
      btn.addEventListener('click', function () { (window.top || window).location = 'admin.html'; });

      var anchor = dropdown.querySelector('[onclick*="profile.html"]') || dropdown.firstElementChild;
      if (anchor && anchor.nextSibling) dropdown.insertBefore(btn, anchor.nextSibling);
      else dropdown.insertBefore(btn, dropdown.firstElementChild);
    })
    .catch(function () {});
}());
