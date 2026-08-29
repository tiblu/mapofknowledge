#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// LOG MONITOR — server/scripts/check-logs.js
// ──────────────────────────────────────────────────────────────────────────
// Standalone script, NOT part of the running mok-server app — invoked
// periodically by a zone.ee panel cron job (raw `crontab` is blocked for
// this account). Reads only the NEW lines appended to the Apache access log
// since its last run (tracked in STATE_FILE), looks for a short list of
// concrete abuse signals, and emails a summary to ALERT_TO if it finds any.
//
// Deliberately narrow — a lightweight tripwire, not a SIEM. Four signals:
//   1. Repeated failed logins from one IP        (brute force)
//   2. Repeated 429s from one IP                 (already hitting our own
//                                                  rate limits — confirmed
//                                                  bot/abuse behaviour)
//   3. 2+ hits on known vulnerability-scanner     (the app never serves these —
//      paths from one IP (wp-login.php, .env...)   but a single drive-by probe
//                                                   is routine internet noise,
//                                                   not a signal worth an email)
//   4. Unusually high total request volume from one IP (scraping / basic DoS)
//
// Cron command (zone.ee panel):
//   /usr/bin/node /data01/virt147958/domeenid/www.themapofknowledge.com/htdocs/server/scripts/check-logs.js
// Recommended schedule: every 15 minutes (*/15 * * * *)
// ══════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const LOG_FILE   = '/data01/virt147958/domeenid/www.themapofknowledge.com/logs/apache.ssl.access.log';
const STATE_FILE = '/data01/virt147958/.mok-log-monitor-state.json';
const ALERT_TO   = 'margo.loor@gmail.com';

const LOGIN_FAIL_THRESHOLD   = 10;   // 401s on POST /auth/login from one IP
const RATE_LIMITED_THRESHOLD = 15;   // 429s (any route) from one IP
const HIGH_VOLUME_THRESHOLD  = 300;  // total requests from one IP
// A lone hit on one scanner path (e.g. the ubiquitous /wp-login.php drive-by
// probe every public site on the internet gets constantly) is background
// noise, not a signal — require a couple of hits (same path twice, or two
// different paths) before it's worth an email.
const SCANNER_HIT_THRESHOLD  = 2;

// The app never serves any of these — a single hit is a scanner, not a user.
const SCANNER_PATH_PATTERNS = [
  /wp-login\.php/i, /wp-admin/i, /xmlrpc\.php/i,
  /\.env$/i, /\.git\/config/i, /\.aws\/credentials/i,
  /phpmyadmin/i, /administrator\//i, /actuator/i, /vendor\/phpunit/i,
  /\.php$/i, // this app has no PHP anywhere — any .php request is a probe
];

// Apache combined-ish format actually in use on this host:
//   host TIMESTAMP IP PORT - - "METHOD PATH HTTP/1.1" STATUS BYTES "REF" "UA" ...
const LINE_RE = /^\S+ (\S+) (\S+) \S+ - - "(\S+) (\S+) HTTP\/[\d.]+" (\d+) \d+ "[^"]*" "([^"]*)"/;

function _readNewLines() {
  let stat;
  try {
    stat = fs.statSync(LOG_FILE);
  } catch (err) {
    // Right after nightly rotation, Apache doesn't recreate this file until
    // its first request of the new day — a brief window where it legitimately
    // doesn't exist yet. Not an error, just nothing to scan this run.
    if (err.code === 'ENOENT') return [];
    throw new Error('Cannot stat log file: ' + err.message);
  }

  let state = { offset: stat.size }; // first run: start watching from now, don't backfill
  if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* corrupt state — treat as first run */ }
  }

  // Log rotated/truncated since last run — can't recover the gap, just
  // resume from the top of the new file rather than erroring out forever.
  const startOffset = stat.size < state.offset ? 0 : state.offset;

  const fd = fs.openSync(LOG_FILE, 'r');
  const length = stat.size - startOffset;
  let text = '';
  if (length > 0) {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, startOffset);
    text = buf.toString('utf8');
  }
  fs.closeSync(fd);

  fs.writeFileSync(STATE_FILE, JSON.stringify({ offset: stat.size }));
  return text.split('\n').filter(Boolean);
}

function _analyze(lines) {
  const loginFails   = new Map(); // ip -> count
  const rateLimited   = new Map(); // ip -> count
  const totalRequests = new Map(); // ip -> count
  const scannerHits    = [];       // { ip, path }

  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, , ip, method, reqPath, status] = m;

    totalRequests.set(ip, (totalRequests.get(ip) || 0) + 1);

    if (status === '401' && method === 'POST' && reqPath === '/auth/login') {
      loginFails.set(ip, (loginFails.get(ip) || 0) + 1);
    }
    if (status === '429') {
      rateLimited.set(ip, (rateLimited.get(ip) || 0) + 1);
    }
    if (SCANNER_PATH_PATTERNS.some((re) => re.test(reqPath))) {
      scannerHits.push({ ip, path: reqPath });
    }
  }

  const findings = [];
  for (const [ip, count] of loginFails) {
    if (count >= LOGIN_FAIL_THRESHOLD) findings.push(`Possible brute force: ${ip} had ${count} failed logins (POST /auth/login).`);
  }
  for (const [ip, count] of rateLimited) {
    if (count >= RATE_LIMITED_THRESHOLD) findings.push(`Repeatedly rate-limited: ${ip} hit 429 responses ${count} times.`);
  }
  for (const [ip, count] of totalRequests) {
    if (count >= HIGH_VOLUME_THRESHOLD) findings.push(`High request volume: ${ip} made ${count} requests.`);
  }
  if (scannerHits.length) {
    const byIp = new Map();
    scannerHits.forEach(({ ip, path: p }) => {
      if (!byIp.has(ip)) byIp.set(ip, []);
      byIp.get(ip).push(p);
    });
    for (const [ip, paths] of byIp) {
      if (paths.length < SCANNER_HIT_THRESHOLD) continue; // one-off drive-by probe — not worth an email
      const distinct = [...new Set(paths)];
      findings.push(`Vulnerability-scanner probe: ${ip} requested ${distinct.slice(0, 5).join(', ')}${distinct.length > 5 ? ', ...' : ''} (${paths.length} hits).`);
    }
  }

  return findings;
}

async function _sendAlert(findings, lineCount) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[check-logs] SMTP not configured — would have alerted on:\n' + findings.join('\n'));
    return;
  }
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT) || 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const body = `Map of Knowledge — log monitor alert\n`
    + `Scanned ${lineCount} new access-log lines.\n\n`
    + findings.map((f) => '- ' + f).join('\n')
    + `\n\nFull log: ssh into the server and check\n${LOG_FILE}`;

  await transporter.sendMail({
    from: '"MoK Log Monitor" <' + (process.env.SMTP_FROM || process.env.SMTP_USER) + '>',
    to: ALERT_TO,
    subject: `[MoK] ${findings.length} suspicious pattern(s) detected`,
    text: body,
  });
}

async function main() {
  const lines = _readNewLines();
  if (!lines.length) return;
  const findings = _analyze(lines);
  if (findings.length) await _sendAlert(findings, lines.length);
}

main().catch((err) => {
  console.error('[check-logs] failed:', err.message);
  process.exit(1);
});
