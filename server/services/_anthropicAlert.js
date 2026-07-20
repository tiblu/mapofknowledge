const db = require('../db');
const { notify } = require('./notifications');
const { sendBillingAlertEmail } = require('./mailer');

// Shared across every Anthropic client instance in the app (llm.js and
// subsetMatcher.js each construct their own) so a simultaneous failure on
// both doesn't double-alert admins — cooldown state lives here, not per-file.
let _lastBillingAlertAt = 0;
const BILLING_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // once per hour, not once per failed request

async function _alertBillingFailure(apiMessage) {
  const [admins] = await db.execute("SELECT id, email FROM users WHERE role = 'super_admin'");
  const title = 'Anthropic API on maksekaetuseta';
  const body  = 'AI-päringud ebaõnnestuvad, sest Anthropic API krediit on otsas. Lisa krediiti Anthropic Console\'is (Plans & Billing), et teenus taastuks.';
  for (const admin of admins) {
    notify(admin.id, 'billing_alert', title, body);
    sendBillingAlertEmail(admin.email, apiMessage).catch(() => {});
  }
}

// Wraps a live Anthropic SDK client's messages.create so a billing/credit
// failure gets surfaced immediately (in-app notification + email to every
// super_admin) instead of sitting silently in a log file — which is how an
// empty Anthropic balance previously went unnoticed until a learner reported
// broken content.
function _wrapWithBillingAlert(client) {
  const origCreate = client.messages.create.bind(client.messages);
  client.messages.create = async function (...args) {
    try {
      return await origCreate(...args);
    } catch (err) {
      const apiMessage = (err && err.message) || '';
      const isBillingError = /credit balance is too low/i.test(apiMessage);
      if (isBillingError && Date.now() - _lastBillingAlertAt > BILLING_ALERT_COOLDOWN_MS) {
        _lastBillingAlertAt = Date.now();
        _alertBillingFailure(apiMessage).catch((e) => console.error('[anthropicAlert] alert failed:', e.message));
      }
      throw err;
    }
  };
}

module.exports = { _wrapWithBillingAlert };
