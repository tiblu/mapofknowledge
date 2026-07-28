/* ══════════════════════════════════════════════
   EMAIL VERIFICATION REMINDER  —  js/verify-banner.js
   Shown only for email+password accounts (Google accounts are pre-verified)
   whose email_verified is still false. Dismiss is per-session — reappears
   next time they log in, since the account really isn't verified yet.
   ══════════════════════════════════════════════ */

(function () {
  // Carried over from the landing page (/?verify=ok etc) for users who were
  // already logged in when they clicked the verification link.
  var verifyParam = new URLSearchParams(window.location.search).get('verify');
  if (verifyParam) {
    var url = new URL(window.location.href);
    url.searchParams.delete('verify');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);

    if (verifyParam === 'ok') {
      var toast = document.createElement('div');
      toast.className = 'verify-banner';
      toast.innerHTML = '<span>' + window.t('verify.confirmed') + '</span>';
      document.body.appendChild(toast);
      setTimeout(function () { toast.remove(); }, 5000);
    }
  }

  fetch('/auth/me').then(function (r) { return r.json(); }).then(function (user) {
    if (!user || !user.id) return;
    if (!user.hasPassword || user.emailVerified) return;
    if (sessionStorage.getItem('kq_verify_banner_dismissed')) return;

    var banner = document.createElement('div');
    banner.className = 'verify-banner';
    banner.innerHTML =
      '<span>' + window.t('verify.reminder') + '</span>' +
      '<button type="button" class="verify-banner-btn" id="verify-banner-resend">' + window.t('btn.resend_verification') + '</button>' +
      '<button type="button" class="verify-banner-close" id="verify-banner-close" aria-label="close">&times;</button>';
    document.body.appendChild(banner);

    document.getElementById('verify-banner-resend').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      var orig = btn.textContent;
      btn.textContent = window.t('msg.sending');
      fetch('/auth/verify-email/resend', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          btn.textContent = d && d.ok ? window.t('msg.sent') : window.t('msg.save_failed_short');
        })
        .catch(function () {
          btn.textContent = window.t('msg.save_failed_short');
        });
    });

    document.getElementById('verify-banner-close').addEventListener('click', function () {
      banner.remove();
      sessionStorage.setItem('kq_verify_banner_dismissed', '1');
    });
  }).catch(function () {});
}());
