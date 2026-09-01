const nodemailer = require('nodemailer');

// Not configured until SMTP_HOST/SMTP_USER/SMTP_PASS are set in .env — until
// then, sends are logged (with the key details, so flows can still be tested
// manually) instead of failing whatever triggered them.
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
const COMPANY_ADDR  = 'Telliskivi tn 60/5, 10412 Tallinn, Estonia, EU';
const CONTACT_EMAIL = 'info@knobitz.com';

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
function _wrapHtml({ bodyHtml, footerNoteHtml, locale }) {
  const questionsLabel = locale === 'en' ? 'Questions? Write to' : 'Küsimusi? Kirjuta';
  return '<!doctype html><html><body style="margin:0;padding:0;background:#F5EEE8;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5EEE8;">'
    + '<tr><td align="center" style="padding:32px 16px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;'
    + 'border-radius:16px;border:1px solid rgba(58,48,40,0.09);font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">'
    + '<tr><td style="padding:24px 32px;border-bottom:1px solid rgba(58,48,40,0.08);">'
    + '<span style="font-size:16px;font-weight:700;color:#2C2820;letter-spacing:-0.2px;">&#9679;&nbsp; KnoBitz</span>'
    + '</td></tr>'
    + '<tr><td style="padding:30px 32px;color:#3A3028;font-size:14px;line-height:1.65;">'
    + bodyHtml
    + '</td></tr>'
    + '<tr><td style="padding:18px 32px;background:#FBF7F2;border-top:1px solid rgba(58,48,40,0.08);'
    + 'font-size:11.5px;color:#9A8E86;line-height:1.7;border-radius:0 0 16px 16px;">'
    + (footerNoteHtml ? footerNoteHtml + '<br><br>' : '')
    + questionsLabel + ' <a href="mailto:' + CONTACT_EMAIL + '" style="color:#C4826A;text-decoration:none;">' + CONTACT_EMAIL + '</a><br>'
    + _escHtml(COMPANY_NAME) + ' &middot; ' + _escHtml(COMPANY_ADDR)
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function _wrapText({ bodyText, footerNoteText, locale }) {
  const questionsLabel = locale === 'en' ? 'Questions?' : 'Küsimusi?';
  return bodyText + '\n\n—\n'
    + (footerNoteText ? footerNoteText + '\n\n' : '')
    + questionsLabel + ' ' + CONTACT_EMAIL + '\n'
    + COMPANY_NAME + ', ' + COMPANY_ADDR;
}

async function _send({ toEmail, subject, bodyHtml, bodyText, footerNoteHtml, footerNoteText, locale }) {
  if (!transporter) {
    console.warn('[mailer] SMTP not configured — would send "' + subject + '" to', toEmail);
    return;
  }
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
    from: '"KnoBitz" <' + fromAddr + '>',
    replyTo: CONTACT_EMAIL,
    to: toEmail,
    subject,
    text: _wrapText({ bodyText, footerNoteText, locale }),
    html: _wrapHtml({ bodyHtml, footerNoteHtml, locale }),
    // A real, if manual, opt-out path — some mail clients surface this as
    // an "Unsubscribe" button next to the sender; it's also a signal spam
    // filters weight in our favour.
    headers: { 'List-Unsubscribe': '<mailto:' + CONTACT_EMAIL + '?subject=unsubscribe>' },
  });
}

async function sendVerificationEmail(toEmail, token, locale) {
  const link = `${process.env.BASE_URL}/auth/verify-email?token=${token}`;
  const subject = locale === 'en' ? 'Verify your KnoBitz email address' : 'Kinnita oma KnoBitzi e-posti aadress';

  const bodyHtml = locale === 'en'
    ? '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Welcome to KnoBitz!</p>'
      + '<p style="margin:0 0 8px;">Click the button below to verify your email address and activate your account.</p>'
      + _btn(link, 'Verify email address')
      + '<p style="margin:22px 0 0;font-size:11.5px;color:#9A8E86;">Or paste this link into your browser:<br>'
      + '<a href="' + link + '" style="color:#C4826A;word-break:break-all;">' + link + '</a></p>'
      + '<p style="margin:14px 0 0;font-size:11.5px;color:#9A8E86;">This link expires in 24 hours.</p>'
    : '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Tere tulemast KnoBitz-i!</p>'
      + '<p style="margin:0 0 8px;">Oma e-posti aadressi kinnitamiseks ja konto aktiveerimiseks kliki alloleval nupul.</p>'
      + _btn(link, 'Kinnita e-post')
      + '<p style="margin:22px 0 0;font-size:11.5px;color:#9A8E86;">Või kopeeri see link oma brauserisse:<br>'
      + '<a href="' + link + '" style="color:#C4826A;word-break:break-all;">' + link + '</a></p>'
      + '<p style="margin:14px 0 0;font-size:11.5px;color:#9A8E86;">Link aegub 24 tunni pärast.</p>';

  const bodyText = locale === 'en'
    ? `Welcome to KnoBitz!\n\nClick the link below to verify your email address:\n\n${link}\n\nThe link expires in 24 hours.`
    : `Tere tulemast KnoBitz-i!\n\nOma e-posti aadressi kinnitamiseks kliki alloleval lingil:\n\n${link}\n\nLink aegub 24 tunni pärast.`;

  const footerNote = locale === 'en'
    ? "If you didn't create a KnoBitz account, you can safely ignore this email — no account will be activated without verification."
    : 'Kui sa ei loonud KnoBitzi kontot, võid seda kirja rahulikult eirata — ilma kinnituseta kontot ei aktiveerita.';

  await _send({ toEmail, subject, bodyHtml, bodyText, footerNoteHtml: footerNote, footerNoteText: footerNote, locale });
}

async function sendPasswordResetEmail(toEmail, token, locale) {
  const link = `${process.env.BASE_URL}/signup.html?resetToken=${token}`;
  const subject = locale === 'en' ? 'Reset your KnoBitz password' : 'Lähtesta oma KnoBitzi parool';

  const bodyHtml = locale === 'en'
    ? '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Reset your password</p>'
      + '<p style="margin:0 0 8px;">We received a request to reset the password on your KnoBitz account. Click the button below to set a new one.</p>'
      + _btn(link, 'Set a new password')
      + '<p style="margin:22px 0 0;font-size:11.5px;color:#9A8E86;">Or paste this link into your browser:<br>'
      + '<a href="' + link + '" style="color:#C4826A;word-break:break-all;">' + link + '</a></p>'
      + '<p style="margin:14px 0 0;font-size:11.5px;color:#9A8E86;">This link expires in 1 hour.</p>'
    : '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Parooli lähtestamine</p>'
      + '<p style="margin:0 0 8px;">Saime taotluse lähtestada sinu KnoBitzi konto parool. Uue parooli määramiseks kliki alloleval nupul.</p>'
      + _btn(link, 'Määra uus parool')
      + '<p style="margin:22px 0 0;font-size:11.5px;color:#9A8E86;">Või kopeeri see link oma brauserisse:<br>'
      + '<a href="' + link + '" style="color:#C4826A;word-break:break-all;">' + link + '</a></p>'
      + '<p style="margin:14px 0 0;font-size:11.5px;color:#9A8E86;">Link aegub 1 tunni pärast.</p>';

  const bodyText = locale === 'en'
    ? `Reset your password\n\nWe received a request to reset the password on your KnoBitz account. Open the link below to set a new one:\n\n${link}\n\nThis link expires in 1 hour.`
    : `Parooli lähtestamine\n\nSaime taotluse lähtestada sinu KnoBitzi konto parool. Uue parooli määramiseks ava see link:\n\n${link}\n\nLink aegub 1 tunni pärast.`;

  const footerNote = locale === 'en'
    ? "If you didn't request this, you can safely ignore this email — your password won't change."
    : 'Kui sa seda taotlust ei esitanud, võid seda kirja rahulikult eirata — su parool jääb samaks.';

  await _send({ toEmail, subject, bodyHtml, bodyText, footerNoteHtml: footerNote, footerNoteText: footerNote, locale });
}

async function sendBillingAlertEmail(toEmail, apiMessage) {
  const subject = 'KnoBitz: Anthropic API krediit on otsas';
  const billingLink = 'https://console.anthropic.com/settings/billing';

  const bodyHtml = '<p style="margin:0 0 16px;font-size:15px;font-weight:650;color:#2C2820;">Anthropic API krediit on otsas</p>'
    + '<p style="margin:0 0 8px;">AI-päringud KnoBitzis ebaõnnestuvad, sest Anthropic API konto krediidijääk on otsas.</p>'
    + _btn(billingLink, 'Lisa krediiti')
    + '<p style="margin:22px 0 4px;font-size:11.5px;color:#9A8E86;">Anthropicu veateade:</p>'
    + '<p style="margin:0;font-size:12px;color:#6E6358;background:#F5EEE8;padding:10px 12px;border-radius:8px;font-family:monospace;">'
    + _escHtml(apiMessage) + '</p>';

  const bodyText = `AI-päringud KnoBitzis ebaõnnestuvad, sest Anthropic API konto krediidijääk on otsas.\n\nLisa krediiti: ${billingLink}\n\nAnthropicu veateade:\n${apiMessage}`;

  const footerNote = 'See teavitus saadetakse maksimaalselt korra tunnis, isegi kui päringud jätkuvad ebaõnnestumast, ja läheb ainult KnoBitzi administraatoritele.';

  await _send({ toEmail, subject, bodyHtml, bodyText, footerNoteHtml: footerNote, footerNoteText: footerNote, locale: 'et' });
}

async function sendChildInviteEmail(toEmail, childName, code, locale) {
  const name = childName || (locale === 'en' ? 'Your child' : 'Sinu laps');
  const subject = locale === 'en' ? `${name} invited you to connect on KnoBitz` : `${name} kutsub sind KnoBitzis ühenduma`;
  const signupLink = process.env.BASE_URL;

  const codeBlock = '<div style="margin:18px 0;padding:14px 18px;background:#F5EEE8;border:1px solid rgba(58,48,40,0.10);'
    + 'border-radius:10px;text-align:center;">'
    + '<span style="font-family:monospace;font-size:20px;font-weight:700;letter-spacing:3px;color:#2C2820;">'
    + _escHtml(code) + '</span></div>';

  const bodyHtml = locale === 'en'
    ? '<p style="margin:0 0 6px;font-size:15px;font-weight:650;color:#2C2820;">' + _escHtml(name) + ' would like to connect on KnoBitz</p>'
      + '<p style="margin:0 0 4px;">so you can follow their learning progress.</p>'
      + '<p style="margin:18px 0 2px;">Sign up or log in, then open Settings and enter this code under "Have a code from your child?":</p>'
      + codeBlock
      + _btn(signupLink, 'Go to KnoBitz')
    : '<p style="margin:0 0 6px;font-size:15px;font-weight:650;color:#2C2820;">' + _escHtml(name) + ' soovib KnoBitzis ühenduda</p>'
      + '<p style="margin:0 0 4px;">et saaksid jälgida tema õppimist.</p>'
      + '<p style="margin:18px 0 2px;">Logi sisse või loo konto, seejärel ava Seaded ja sisesta see kood väljal "Kas sul on lapse kood?":</p>'
      + codeBlock
      + _btn(signupLink, 'Ava KnoBitz');

  const bodyText = locale === 'en'
    ? `${name} would like to connect their KnoBitz account with yours, so you can follow their learning progress.\n\nSign up or log in at ${signupLink}, then open Settings and enter this code under "Have a code from your child?":\n\n${code}`
    : `${name} soovib ühendada oma KnoBitzi konto sinu omaga, et saaksid jälgida tema õppimist.\n\nLogi sisse või loo konto aadressil ${signupLink}, seejärel ava Seaded ja sisesta see kood väljal "Kas sul on lapse kood?":\n\n${code}`;

  const footerNote = locale === 'en'
    ? "You're receiving this because someone entered your email address on KnoBitz to request a connection. If you weren't expecting this or don't want emails like this, just let us know."
    : 'Said selle kirja, sest keegi sisestas KnoBitzis sinu e-posti aadressi, et paluda ühendust. Kui sa seda ei oodanud või ei soovi selliseid kirju, anna meile teada.';

  await _send({ toEmail, subject, bodyHtml, bodyText, footerNoteHtml: footerNote, footerNoteText: footerNote, locale });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendBillingAlertEmail, sendChildInviteEmail };
