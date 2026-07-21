const nodemailer = require('nodemailer');

// Not configured until SMTP_HOST/SMTP_USER/SMTP_PASS are set in .env — until
// then, sends are logged (with the link, so verification can still be tested
// manually) instead of failing signup.
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

async function sendVerificationEmail(toEmail, token, locale) {
  const link = `${process.env.BASE_URL}/auth/verify-email?token=${token}`;
  const subject = locale === 'en' ? 'Verify your KnoBitz email address' : 'Kinnita oma KnoBitzi e-posti aadress';
  const text = locale === 'en'
    ? `Welcome to KnoBitz!\n\nClick the link below to verify your email address:\n\n${link}\n\nThe link expires in 24 hours. If you didn't create a KnoBitz account, you can ignore this email.`
    : `Tere tulemast KnoBitz-i!\n\nOma e-posti aadressi kinnitamiseks kliki alloleval lingil:\n\n${link}\n\nLink aegub 24 tunni pärast. Kui sa ei loonud KnoBitzi kontot, võid selle kirja eirata.`;

  if (!transporter) {
    console.warn('[mailer] SMTP not configured — verification link for', toEmail + ':', link);
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject,
    text,
  });
}

async function sendBillingAlertEmail(toEmail, apiMessage) {
  const subject = 'KnoBitz: Anthropic API krediit on otsas';
  const text = `AI-päringud KnoBitzis ebaõnnestuvad, sest Anthropic API konto krediidijääk on otsas.\n\n`
    + `Lisa krediiti: https://console.anthropic.com/settings/billing\n\n`
    + `Anthropicu veateade:\n${apiMessage}\n\n`
    + `See teavitus saadetakse maksimaalselt korra tunnis, isegi kui päringud jätkuvad ebaõnnestumast.`;

  if (!transporter) {
    console.warn('[mailer] SMTP not configured — billing alert for', toEmail + ':', text);
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject,
    text,
  });
}

async function sendChildInviteEmail(toEmail, childName, code, locale) {
  const name = childName || (locale === 'en' ? 'Your child' : 'Sinu laps');
  const subject = locale === 'en' ? `${name} invited you to connect on KnoBitz` : `${name} kutsub sind KnoBitzis ühenduma`;
  const text = locale === 'en'
    ? `${name} would like to connect their KnoBitz account with yours, so you can follow their learning progress.\n\nSign up or log in at ${process.env.BASE_URL}, then open Settings and enter this code under "Have a code from your child?":\n\n${code}\n\nIf you weren't expecting this, you can ignore this email.`
    : `${name} soovib ühendada oma KnoBitzi konto sinu omaga, et saaksid jälgida tema õppimist.\n\nLogi sisse või loo konto aadressil ${process.env.BASE_URL}, seejärel ava Seaded ja sisesta see kood väljal "Kas sul on lapse kood?":\n\n${code}\n\nKui sa seda ei oodanud, võid selle kirja eirata.`;

  if (!transporter) {
    console.warn('[mailer] SMTP not configured — child invite code for', toEmail + ':', code);
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject,
    text,
  });
}

module.exports = { sendVerificationEmail, sendBillingAlertEmail, sendChildInviteEmail };
