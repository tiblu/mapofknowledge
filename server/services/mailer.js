const nodemailer = require('nodemailer');

// Not configured until SMTP_HOST/SMTP_USER/SMTP_PASS are set in .env — until
// then, sends are logged (with the key details, so the signup flow can still
// be tested manually) instead of failing whatever triggered them.
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const port = Number(process.env.SMTP_PORT) || 465;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const COMPANY_NAME  = 'OÜ KaiQ';
const CONTACT_EMAIL = 'info@themapofknowledge.com';

function _escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A real button rather than a bare link — reads as a legitimate product
// email rather than a one-line auto-generated notice.
function _btn(href, label) {
  return '<a href="' + href + '" style="display:inline-block;background:#C4826A;color:#FFFFFF;'
    + 'font-weight:600;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:10px;'
    + 'margin:10px 0 6px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">'
    + _escHtml(label) + '</a>';
}

/* ── Shared branded shell ──────────────────────────────────────────────
   Table-based layout + inline styles throughout, since Outlook desktop's
   Word rendering engine ignores most CSS that isn't either inline or on a
   <table>. No embedded logo image (clients hide remote images by default
   until the user clicks "show images", which would leave the header
   looking broken) — a plain text wordmark instead. */
function _wrapHtml({ bodyHtml, footerNoteHtml }) {
  return '<!doctype html><html><body style="margin:0;padding:0;background:#F5EEE8;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5EEE8;">'
    + '<tr><td align="center" style="padding:32px 16px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;'
    + 'border-radius:16px;border:1px solid rgba(58,48,40,0.09);font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">'
    + '<tr><td style="padding:24px 32px;border-bottom:1px solid rgba(58,48,40,0.08);">'
    + '<span style="font-size:16px;font-weight:700;color:#2C2820;letter-spacing:-0.2px;">&#9679;&nbsp; Map of Knowledge</span>'
    + '</td></tr>'
    + '<tr><td style="padding:30px 32px;color:#3A3028;font-size:14px;line-height:1.65;">'
    + bodyHtml
    + '</td></tr>'
    + '<tr><td style="padding:18px 32px;background:#FBF7F2;border-top:1px solid rgba(58,48,40,0.08);'
    + 'font-size:11.5px;color:#9A8E86;line-height:1.7;border-radius:0 0 16px 16px;">'
    + (footerNoteHtml ? footerNoteHtml + '<br><br>' : '')
    + 'Questions? Write to <a href="mailto:' + CONTACT_EMAIL + '" style="color:#C4826A;text-decoration:none;">' + CONTACT_EMAIL + '</a><br>'
    + _escHtml(COMPANY_NAME)
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function _wrapText({ bodyText, footerNoteText }) {
  return bodyText + '\n\n—\n'
    + (footerNoteText ? footerNoteText + '\n\n' : '')
    + 'Questions? ' + CONTACT_EMAIL + '\n'
    + COMPANY_NAME;
}

async function _send({ toEmail, subject, bodyHtml, bodyText, footerNoteHtml, footerNoteText }) {
  if (!transporter) {
    console.warn('[mailer] SMTP not configured — would send "' + subject + '" to', toEmail);
    return;
  }
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
    from: '"Map of Knowledge" <' + fromAddr + '>',
    replyTo: CONTACT_EMAIL,
    to: toEmail,
    subject,
    text: _wrapText({ bodyText, footerNoteText }),
    html: _wrapHtml({ bodyHtml, footerNoteHtml }),
    // A real, if manual, opt-out path — some mail clients surface this as
    // an "Unsubscribe" button next to the sender; it's also a signal spam
    // filters weight in our favour.
    headers: { 'List-Unsubscribe': '<mailto:' + CONTACT_EMAIL + '?subject=unsubscribe>' },
  });
}

async function sendVerificationEmail(toEmail, token, locale) {
  const link = `${process.env.BASE_URL}/auth/verify-email?token=${token}`;
  const subject = locale === 'et' ? 'Kinnita oma Map of Knowledge e-posti aadress' : 'Verify your Map of Knowledge email address';

  const bodyHtml = locale === 'et'
    ? '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Tere tulemast Map of Knowledge\'sse!</p>'
      + '<p style="margin:0 0 8px;">Oma e-posti aadressi kinnitamiseks ja konto aktiveerimiseks kliki alloleval nupul.</p>'
      + _btn(link, 'Kinnita e-post')
      + '<p style="margin:22px 0 0;font-size:11.5px;color:#9A8E86;">Või kopeeri see link oma brauserisse:<br>'
      + '<a href="' + link + '" style="color:#C4826A;word-break:break-all;">' + link + '</a></p>'
      + '<p style="margin:14px 0 0;font-size:11.5px;color:#9A8E86;">Link aegub 24 tunni pärast.</p>'
    : '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Welcome to Map of Knowledge!</p>'
      + '<p style="margin:0 0 8px;">Click the button below to verify your email address and activate your account.</p>'
      + _btn(link, 'Verify email address')
      + '<p style="margin:22px 0 0;font-size:11.5px;color:#9A8E86;">Or paste this link into your browser:<br>'
      + '<a href="' + link + '" style="color:#C4826A;word-break:break-all;">' + link + '</a></p>'
      + '<p style="margin:14px 0 0;font-size:11.5px;color:#9A8E86;">This link expires in 24 hours.</p>';

  const bodyText = locale === 'et'
    ? `Tere tulemast Map of Knowledge'sse!\n\nOma e-posti aadressi kinnitamiseks kliki alloleval lingil:\n\n${link}\n\nLink aegub 24 tunni pärast.`
    : `Welcome to Map of Knowledge!\n\nClick the link below to verify your email address:\n\n${link}\n\nThe link expires in 24 hours.`;

  const footerNote = locale === 'et'
    ? 'Kui sa ei loonud Map of Knowledge kontot, võid seda kirja rahulikult eirata — ilma kinnituseta kontot ei aktiveerita.'
    : "If you didn't create a Map of Knowledge account, you can safely ignore this email — no account will be activated without verification.";

  await _send({ toEmail, subject, bodyHtml, bodyText, footerNoteHtml: footerNote, footerNoteText: footerNote });
}

async function sendPasswordResetEmail(toEmail, token, locale) {
  const link = `${process.env.BASE_URL}/signup.html?resetToken=${token}`;
  const subject = locale === 'et' ? 'Lähtesta oma Map of Knowledge parool' : 'Reset your Map of Knowledge password';

  const bodyHtml = locale === 'et'
    ? '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Parooli lähtestamine</p>'
      + '<p style="margin:0 0 8px;">Saime taotluse lähtestada sinu Map of Knowledge konto parool. Uue parooli määramiseks kliki alloleval nupul.</p>'
      + _btn(link, 'Määra uus parool')
      + '<p style="margin:22px 0 0;font-size:11.5px;color:#9A8E86;">Või kopeeri see link oma brauserisse:<br>'
      + '<a href="' + link + '" style="color:#C4826A;word-break:break-all;">' + link + '</a></p>'
      + '<p style="margin:14px 0 0;font-size:11.5px;color:#9A8E86;">Link aegub 1 tunni pärast.</p>'
    : '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Reset your password</p>'
      + '<p style="margin:0 0 8px;">We received a request to reset the password on your Map of Knowledge account. Click the button below to set a new one.</p>'
      + _btn(link, 'Set a new password')
      + '<p style="margin:22px 0 0;font-size:11.5px;color:#9A8E86;">Or paste this link into your browser:<br>'
      + '<a href="' + link + '" style="color:#C4826A;word-break:break-all;">' + link + '</a></p>'
      + '<p style="margin:14px 0 0;font-size:11.5px;color:#9A8E86;">This link expires in 1 hour.</p>';

  const bodyText = locale === 'et'
    ? `Parooli lähtestamine\n\nSaime taotluse lähtestada sinu Map of Knowledge konto parool. Uue parooli määramiseks ava see link:\n\n${link}\n\nLink aegub 1 tunni pärast.`
    : `Reset your password\n\nWe received a request to reset the password on your Map of Knowledge account. Open the link below to set a new one:\n\n${link}\n\nThis link expires in 1 hour.`;

  const footerNote = locale === 'et'
    ? 'Kui sa seda taotlust ei esitanud, võid seda kirja rahulikult eirata — su parool jääb samaks.'
    : "If you didn't request this, you can safely ignore this email — your password won't change.";

  await _send({ toEmail, subject, bodyHtml, bodyText, footerNoteHtml: footerNote, footerNoteText: footerNote });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
