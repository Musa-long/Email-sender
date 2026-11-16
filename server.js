'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || 'change-me';
const BREVO_KEY = process.env.BREVO_API_KEY || '';
const COMPANY = process.env.COMPANY_NAME || 'Northwind';
const ADDRESS = process.env.COMPANY_ADDRESS || '41 Kingsway, London WC2B 6EX, UK';
const TEST_MODE = String(process.env.TEST_MODE || 'true') === 'true';

const MEDIA_DIR = '/tmp/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR));

const auth = (req, res, next) => {
  const code = req.get('x-access-code') || req.query.code;
  if (code !== ACCESS_CODE) return res.status(401).json({ error: 'Wrong access code' });
  next();
};

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- the email design ----------
function buildEmail(f) {
  const media = f.mediaPath ? `<tr><td><img src="${esc(f.mediaPath)}" width="600" alt="" style="display:block;width:100%;height:auto;border:0;"></td></tr>` : '';
  const paragraphs = String(f.body || '').split(/\n{2,}/).filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3f4653;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const button = f.link
    ? `<tr><td style="padding:22px 30px 8px;">
         <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${esc(f.accent)};border-radius:6px;">
           <a href="${esc(f.link)}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none;">${esc(f.buttonText || 'Learn more')}</a>
         </td></tr></table>
         <p style="margin:14px 0 0;font-size:13px;color:#8b93a1;word-break:break-all;">${esc(f.link)}</p>
       </td></tr>` : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(f.subject)}</title></head>
<body style="margin:0;padding:0;background:#eef0f3;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f3;padding:36px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e2e5e9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:22px 30px;border-bottom:1px solid #eef0f3;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="width:28px;height:28px;background:${esc(f.accent)};border-radius:7px;text-align:center;color:#ffffff;font-weight:700;line-height:28px;">${esc((f.company || 'N').charAt(0).toUpperCase())}</td>
    <td style="padding-left:9px;font-weight:700;color:#111827;font-size:16px;">${esc(f.company)}</td>
  </tr></table>
</td></tr>
${media}
<tr><td style="padding:26px 30px 0;">
  <h1 style="margin:0 0 12px;font-size:23px;line-height:1.3;color:#111827;font-weight:600;letter-spacing:-.4px;">${esc(f.headline)}</h1>
  ${paragraphs}
</td></tr>
${button}
<tr><td style="padding:22px 30px 26px;">
  <hr style="border:0;border-top:1px solid #eceef1;margin:0 0 14px;">
  <p style="margin:0;font-size:11.5px;line-height:1.7;color:#9aa1ac;">${esc(f.company)} · ${esc(ADDRESS)}<br>
  You're receiving this because you subscribed. <a href="${esc(f.unsubscribeUrl)}" style="color:#9aa1ac;">Unsubscribe</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

// ---------- image upload ----------
app.post('/api/upload', auth, (req, res) => {
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec((req.body || {}).dataUrl || '');
  if (!m) return res.status(400).json({ error: 'PNG, JPG, WEBP or GIF only' });
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Image must be under 5 MB' });
  const file = crypto.randomBytes(8).toString('hex') + '.' + m[2].replace('jpeg', 'jpg');
  fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
  res.json({ path: '/media/' + file });
});

// ---------- preview ----------
app.post('/api/preview', auth, (req, res) => {
  const b = req.body || {};
  res.json({ html: buildEmail({ ...b, company: COMPANY }) });
});

// ---------- send ----------
const jobs = new Map();
const pub = (j) => ({ total: j.total, sent: j.sent, failed: j.failed, status: j.status, errors: j.errors.slice(-20) });
const emit = (j) => j.listeners.forEach((r) => r.write(`data: ${JSON.stringify(pub(j))}\n\n`));

app.post('/api/send', auth, async (req, res) => {
  const b = req.body || {};
  const list = [...new Set((b.recipients || []).map((r) => String(r).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
  if (!list.length) return res.status(400).json({ error: 'No valid email addresses' });
  if (!b.subject) return res.status(400).json({ error: 'Subject is required' });
  if (!b.fromEmail) return res.status(400).json({ error: 'From address is required' });

  const origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  const job = { id: crypto.randomBytes(6).toString('hex'), total: list.length, sent: 0, failed: 0, status: 'running', errors: [], listeners: [], cancelled: false };
  jobs.set(job.id, job);
  res.json({ jobId: job.id });

  for (const to of list) {
    if (job.cancelled) { job.status = 'cancelled'; return emit(job); }
    const first = to.split('@')[0].replace(/[._-]/g, ' ');
    const vars = {
      ...b,
      company: COMPANY,
      mediaPath: b.mediaPath ? origin + b.mediaPath : '',
      unsubscribeUrl: `${origin}/unsubscribe?e=${encodeURIComponent(to)}`,
      body: String(b.body || '').replace(/\{\{\s*first_name\s*\}\}/gi, first),
      headline: String(b.headline || '').replace(/\{\{\s*first_name\s*\}\}/gi, first),
    };
    try {
      if (TEST_MODE) {
        await new Promise((r) => setTimeout(r, 150));
      } else {
        const r = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: { name: b.fromName || COMPANY, email: b.fromEmail },
            replyTo: b.replyTo ? { email: b.replyTo } : undefined,
            to: [{ email: to }],
            subject: vars.headline ? b.subject : b.subject,
            htmlContent: buildEmail(vars),
            textContent: `${vars.headline}\n\n${vars.body}\n\n${b.link || ''}`.trim(),
            headers: { 'List-Unsubscribe': `<${vars.unsubscribeUrl}>` },
          }),
        });
        if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
      job.sent++;
    } catch (e) {
      job.failed++;
      job.errors.push({ to, error: String(e.message || e) });
    }
    emit(job);
    await new Promise((r) => setTimeout(r, Number(b.delayMs) || 1100));
  }
  job.status = 'done';
  emit(job);
});

app.get('/api/jobs/:id/stream', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify(pub(job))}\n\n`);
  job.listeners.push(res);
  req.on('close', () => { job.listeners = job.listeners.filter((x) => x !== res); });
});

app.post('/api/jobs/:id/cancel', auth, (req, res) => {
  const j = jobs.get(req.params.id);
  if (j) j.cancelled = true;
  res.json({ ok: true });
});

app.get('/healthz', (_q, r) => r.send('ok'));
app.listen(PORT, () => console.log('up on ' + PORT + (TEST_MODE ? ' [TEST MODE]' : '')));
