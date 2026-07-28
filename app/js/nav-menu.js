/* ══════════════════════════════════════════════
   NAV MENU  —  js/nav-menu.js
   Single source of truth for the burger/nav-dropdown menu, included on
   every page that has an empty <div id="nav-dropdown" class="nav-dropdown">
   shell. Builds the same item list, in the same order, with the same
   behavior everywhere — no page hand-copies this markup anymore.

   Click behavior is resolved per-item at render time, not hardcoded per
   page:
     - the current page's own item gets .active-page and no handler
     - Admin and Map always break out to a real top-level navigation (Admin
       is a standalone page, never an overlay; the map is the outer frame
       everything else overlays *onto*, so it can't overlay itself), even
       from inside an overlay iframe
     - Log out always breaks out to the top window
     - everything else uses window.openOverlay(page) when that function
       exists (true only on index.html, the one page with a live map +
       overlay-iframe system) and falls back to plain navigation otherwise
       — which is exactly what every page already did individually before
       this was centralized.
   ══════════════════════════════════════════════ */

(function () {
  var dropdown = document.getElementById('nav-dropdown');
  if (!dropdown) return;

  var ICONS = {
    account: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
      + '<circle cx="7.5" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2"/>'
      + '<path d="M2 13c0-2.8 2.5-4.5 5.5-4.5s5.5 1.7 5.5 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
      + '</svg>',
    admin: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
      + '<rect x="1.5" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>'
      + '<path d="M5 3V2M10 3V2M1.5 6.5h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
      + '</svg>',
    notifications: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
      + '<path d="M7.5 1.5a4 4 0 0 0-4 4v2.5L2.5 9.5h10l-1-1.5V5.5a4 4 0 0 0-4-4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
      + '<path d="M6 11.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" stroke-width="1.2"/>'
      + '</svg>',
    logout: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
      + '<path d="M5.5 7.5h7M10 5l2.5 2.5L10 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M8 3H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
      + '</svg>',
    help: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
      + '<circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" stroke-width="1.2"/>'
      + '<path d="M5.7 5.8a1.8 1.8 0 1 1 2.5 1.7c-.5.3-.7.6-.7 1.1v.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
      + '<circle cx="7.5" cy="10.8" r="0.6" fill="currentColor"/>'
      + '</svg>',
    map: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
      + '<circle cx="7.5" cy="7.5" r="1.3" fill="currentColor"/>'
      + '<circle cx="7.5" cy="2.2" r="1" fill="currentColor" opacity="0.5"/>'
      + '<circle cx="7.5" cy="12.8" r="1" fill="currentColor" opacity="0.5"/>'
      + '<circle cx="2.2" cy="7.5" r="1" fill="currentColor" opacity="0.5"/>'
      + '<circle cx="12.8" cy="7.5" r="1" fill="currentColor" opacity="0.5"/>'
      + '</svg>',
  };

  var current = (window.location.pathname.split('/').pop() || 'index.html');

  function navigateTo(page) {
    if (typeof window.openOverlay === 'function') window.openOverlay(page);
    else window.location = page;
  }

  function makeItem(opts) {
    // opts: { page, i18nKey, fallback, iconHtml, badge }
    var btn = document.createElement('button');
    btn.className = 'nav-dropdown-item';
    var inner = opts.iconHtml
      + '<span data-i18n="' + opts.i18nKey + '">' + opts.fallback + '</span>';
    if (opts.badge) inner += '<span id="nav-notif-badge"></span>';
    btn.innerHTML = inner;

    if (opts.page === current) {
      btn.classList.add('active-page');
    } else if (opts.page === 'admin.html' || opts.page === 'index.html') {
      // Admin is a standalone page, never an overlay. The map (index.html) is
      // the outer frame everything else overlays *onto* — it can't sensibly be
      // opened as an overlay of itself, so it also always breaks out top-level.
      btn.addEventListener('click', function () { (window.top || window).location = opts.page; });
    } else {
      btn.addEventListener('click', function () { navigateTo(opts.page); });
    }
    return btn;
  }

  function makeLogout() {
    var btn = document.createElement('button');
    btn.className = 'nav-dropdown-item';
    btn.innerHTML = ICONS.logout + '<span data-i18n="nav.log_out">Log out</span>';
    btn.addEventListener('click', function () { window.top.location = '/auth/logout'; });
    return btn;
  }

  function divider() {
    var d = document.createElement('div');
    d.className = 'nav-dropdown-divider';
    return d;
  }

  // ── Static items (no role check needed) ─────────────────────────────────────
  // Order: Notifications, Map, Account, (Admin), divider, Settings, Help, divider, Log out
  var notifItem   = makeItem({ page: 'notifications.html', i18nKey: 'nav.notifications', fallback: 'Notifications', iconHtml: ICONS.notifications, badge: true });
  var mapItem     = makeItem({ page: 'index.html', i18nKey: 'nav.map', fallback: 'Map', iconHtml: ICONS.map });
  var accountItem = makeItem({ page: 'profile.html', i18nKey: 'nav.account', fallback: 'Account', iconHtml: ICONS.account });

  var settingsBtn = document.createElement('button');
  settingsBtn.className = 'nav-dropdown-item';
  settingsBtn.innerHTML = '<img src="images/icon-settings.svg" width="15" height="15" alt="">'
    + '<span data-i18n="nav.settings">Settings</span>';
  if ('settings.html' === current) settingsBtn.classList.add('active-page');
  else settingsBtn.addEventListener('click', function () { navigateTo('settings.html'); });

  var helpItem = makeItem({ page: 'help.html', i18nKey: 'nav.help', fallback: 'Help', iconHtml: ICONS.help });

  dropdown.appendChild(notifItem);
  dropdown.appendChild(mapItem);
  dropdown.appendChild(accountItem);
  dropdown.appendChild(divider());
  dropdown.appendChild(settingsBtn);
  dropdown.appendChild(helpItem);
  dropdown.appendChild(divider());
  dropdown.appendChild(makeLogout());

  // ── Admin item — only for super_admin, inserted right after Account once known ──
  fetch('/auth/me')
    .then(function (r) { return r.json(); })
    .then(function (user) {
      if (!user || user.role !== 'super_admin') return;
      var adminItem = makeItem({ page: 'admin.html', i18nKey: 'nav.admin', fallback: 'Admin', iconHtml: ICONS.admin });
      dropdown.insertBefore(adminItem, accountItem.nextSibling);
    })
    .catch(function () {});
}());
