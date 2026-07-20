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

module.exports = { sendVerificationEmail };
