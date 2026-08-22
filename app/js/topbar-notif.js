(function () {
  // Exposed globally (not just a one-shot IIFE) so index.html's closeOverlay
  // can re-check unread state when the notifications page — loaded in an
  // iframe overlay, not a real navigation — closes. Without this, marking a
  // notification read inside the overlay only ever updated the iframe's own
  // copy of the dot; the parent map view's dot never learned about it, since
  // this script otherwise only ran once at initial page load.
  window.refreshNotifDot = function () {
    fetch('/api/notifications/unread-count')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var count = data.count || 0;
        var dot = document.getElementById('topbar-notif-dot');
        if (dot) dot.style.display = count > 0 ? 'block' : 'none';
        var badge = document.getElementById('nav-notif-badge');
        if (badge) {
          if (count > 0) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.style.display = 'inline-block';
          } else {
            badge.style.display = 'none';
          }
        }
      })
      .catch(function () {});
  };
  window.refreshNotifDot();
})();
