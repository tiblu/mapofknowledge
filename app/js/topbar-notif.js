window.refreshNotifBadge = function () {
  fetch('/api/notifications/unread-count')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var count = data.count || 0;
      var dot   = document.getElementById('topbar-notif-dot');
      var badge = document.getElementById('nav-notif-badge');
      if (dot)   dot.style.display  = count ? 'block' : 'none';
      if (badge) {
        if (count) {
          badge.textContent   = count > 99 ? '99+' : String(count);
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }
    })
    .catch(function () {});
};

window.refreshNotifBadge();
