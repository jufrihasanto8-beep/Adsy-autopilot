// api/notify-wa.js — WA notif + Top Up handler
// Actions (POST): send | extract_topup | notify_topup | approve_topup
// GET: ?action=approve&id=xxx&token=yyy → halaman konfirmasi approve
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── HTML helpers untuk approve page ──
const htmlPage = (icon, title, msg, color) => `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f6fa;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
  .card{background:#fff;border-radius:20px;padding:40px 32px;text-align:center;max-width:400px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
  .icon{font-size:56px;margin-bottom:16px;}
  h1{font-size:20px;font-weight:700;color:${color};margin-bottom:8px;}
  p{font-size:14px;color:#64748b;line-height:1.6;}
  .sub{font-size:12px;color:#94a3b8;margin-top:16px;}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${msg}</p>
    <div class="sub">Kamu bisa tutup halaman ini.</div>
  </div>
</body>
</html>`;

const htmlConfirm = (r, id, token) => {
  const fmtNum = n => n != null ? Number(n).toLocaleString('id-ID') : '-';
  const ext = r.extracted_data || {};
  const rec = r.ai_recommendation || {};
  const levelColor = { good: '#10b981', moderate: '#f59e0b', poor: '#ef4444' }[rec.level] || '#6366f1';
  const levelLabel = { good: 'Performa Baik', moderate: 'Performa Cukup', poor: 'Performa Rendah' }[rec.level] || '-';

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Konfirmasi Approve Top Up</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f6fa;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
  .card{background:#fff;border-radius:20px;padding:36px 28px;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
  h1{font-size:18px;font-weight:700;color:#1e293b;margin-bottom:4px;}
  .sub{font-size:13px;color:#64748b;margin-bottom:20px;}
  .info{background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:16px;}
  .info-row{display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px solid #f1f5f9;}
  .info-row:last-child{border-bottom:none;}
  .info-row .lbl{color:#64748b;}
  .info-row .val{font-weight:600;color:#1e293b;}
  .rec-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:16px;background:${levelColor}1a;color:${levelColor};border:1.5px solid ${levelColor}33;}
  .rec-reason{font-size:12px;color:#64748b;background:#f8fafc;padding:10px 12px;border-radius:8px;margin-bottom:16px;line-height:1.6;}
  .field label{display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px;}
  .field input{width:100%;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:16px;font-weight:700;font-family:inherit;outline:none;transition:border-color .2s;}
  .field input:focus{border-color:#6366f1;}
  .field .prefix-wrap{position:relative;}
  .field .prefix{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:#64748b;font-weight:600;}
  .field input.has-prefix{padding-left:38px;}
  .btn{width:100%;padding:14px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:12px;transition:background .2s;}
  .btn-approve{background:#6366f1;color:#fff;}
  .btn-approve:hover{background:#4f46e5;}
  .btn-approve:disabled{background:#94a3b8;cursor:not-allowed;}
  .btn-reject{background:#fff;color:#ef4444;border:1.5px solid #fca5a5;}
  .btn-reject:hover{background:#fef2f2;}
  .note{font-size:11px;color:#94a3b8;text-align:center;margin-top:12px;}
</style>
</head>
<body>
<div class="card">
  <h1>💳 Konfirmasi Approve Top Up</h1>
  <div class="sub">Review data sebelum approve</div>

  <div class="info">
    <div class="info-row"><span class="lbl">Advertiser</span><span class="val">${r.user_name || '-'}</span></div>
    <div class="info-row"><span class="lbl">Produk</span><span class="val">${r.product_name || '-'}</span></div>
    <div class="info-row"><span class="lbl">Nominal Request</span><span class="val">Rp ${fmtNum(r.nominal_request)}</span></div>
    ${ext.spend != null ? `<div class="info-row"><span class="lbl">Spend Kemarin</span><span class="val">Rp ${fmtNum(ext.spend)}</span></div>` : ''}
    ${ext.results != null ? `<div class="info-row"><span class="lbl">Hasil (Lead)</span><span class="val">${fmtNum(ext.results)}</span></div>` : ''}
    ${ext.cpr != null ? `<div class="info-row"><span class="lbl">CPR</span><span class="val">Rp ${fmtNum(ext.cpr)}</span></div>` : ''}
  </div>

  ${(r.billing_data?.saldo_saat_ini != null || r.billing_data?.kartu_kredit_nama) ? `
  <div style="font-size:12px;font-weight:700;color:var(--text-sub,#64748b);margin-bottom:6px;margin-top:12px;">🏦 Info Billing</div>
  <div class="info">
    ${r.ad_account_name ? `<div class="info-row"><span class="lbl">Akun Iklan</span><span class="val">${r.ad_account_name}</span></div>` : ''}
    ${r.billing_data?.saldo_saat_ini != null ? `<div class="info-row"><span class="lbl">Saldo Saat Ini</span><span class="val">Rp ${fmtNum(r.billing_data.saldo_saat_ini)}</span></div>` : ''}
    ${r.billing_data?.jangkauan_saldo != null ? `<div class="info-row"><span class="lbl">Jangkauan Saldo</span><span class="val">Rp ${fmtNum(r.billing_data.jangkauan_saldo)}</span></div>` : ''}
    ${r.billing_data?.kartu_kredit_nama ? `<div class="info-row"><span class="lbl">Kartu Kredit</span><span class="val">${r.billing_data.kartu_kredit_nama} ····${r.billing_data.kartu_kredit_nomor || ''}</span></div>` : ''}
  </div>` : ''}
  </div>

  ${rec.level ? `
  <div class="rec-badge">⚡ ${levelLabel} — Rekomendasi ${rec.recommendation_pct || '-'}%</div>
  ${rec.reason ? `<div class="rec-reason">${rec.reason}</div>` : ''}
  ` : ''}

  <form id="frm" onsubmit="handleSubmit(event)">
    <input type="hidden" name="action" value="approve" />
    <div class="field" style="margin-bottom:8px;">
      <label>Nominal yang Disetujui</label>
      <div class="prefix-wrap">
        <span class="prefix">Rp</span>
        <input type="text" id="inp-nominal" name="nominal_disetujui" class="has-prefix"
          placeholder="${Number(r.nominal_request).toLocaleString('id-ID')}"
          value="${Number(r.nominal_request).toLocaleString('id-ID')}"
          inputmode="numeric"
          oninput="this.value=this.value.replace(/[^0-9.,]/g,'').replace(/\\.(?=.*\\.)/g,'')" />
      </div>
    </div>
    <div class="field" style="margin-bottom:4px;">
      <label>Catatan (opsional)</label>
      <input type="text" name="catatan" placeholder="Catatan untuk advertiser..." />
    </div>
    <button type="submit" class="btn btn-approve" id="btn-approve">✅ Approve Sekarang</button>
  </form>

  <form method="POST" action="/api/notify-wa?action=approve&id=${id}&token=${token}&reject=1" onsubmit="handleReject(event)">
    <button type="submit" class="btn btn-reject" id="btn-reject">❌ Tolak Request</button>
  </form>

  <div class="note">Setelah approve, notifikasi WA otomatis dikirim ke advertiser.</div>
</div>
<script>
  async function handleSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-approve');
    btn.disabled = true; btn.textContent = 'Memproses...';

    const raw = document.getElementById('inp-nominal').value.replace(/[^0-9]/g, '');
    const catatan = e.target.catatan.value;

    try {
      const r = await fetch('/api/notify-wa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_topup', id: '${id}', token: '${token}', nominal_disetujui: Number(raw), catatan })
      });
      const d = await r.json();
      if (d.ok) {
        document.querySelector('.card').innerHTML = '<div style="text-align:center;padding:40px 0"><div style="font-size:56px">✅</div><h1 style="font-size:20px;color:#10b981;margin:16px 0 8px">Disetujui!</h1><p style="color:#64748b;font-size:14px">Notifikasi sudah dikirim ke advertiser.</p></div>';
      } else {
        alert('Error: ' + (d.error || 'Gagal approve'));
        btn.disabled = false; btn.textContent = '✅ Approve Sekarang';
      }
    } catch(err) {
      alert('Error: ' + err.message);
      btn.disabled = false; btn.textContent = '✅ Approve Sekarang';
    }
  }

  async function handleReject(e) {
    e.preventDefault();
    if (!confirm('Yakin mau tolak request top up ini?')) return;
    const catatan = prompt('Alasan penolakan (opsional):') || '';
    const btn = document.getElementById('btn-reject');
    btn.disabled = true; btn.textContent = 'Memproses...';

    try {
      const r = await fetch('/api/notify-wa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_topup', id: '${id}', token: '${token}', reject: true, catatan })
      });
      const d = await r.json();
      if (d.ok) {
        document.querySelector('.card').innerHTML = '<div style="text-align:center;padding:40px 0"><div style="font-size:56px">❌</div><h1 style="font-size:20px;color:#ef4444;margin:16px 0 8px">Ditolak</h1><p style="color:#64748b;font-size:14px">Request top up sudah ditolak.</p></div>';
      } else {
        alert('Error: ' + (d.error || 'Gagal tolak'));
        btn.disabled = false; btn.textContent = '❌ Tolak Request';
      }
    } catch(err) {
      alert(err.message);
      btn.disabled = false; btn.textContent = '❌ Tolak Request';
    }
  }
</script>
</body>
</html>`;
};

// Hitung rekomendasi budget berdasarkan CPR vs target — pure math, tidak pakai AI
function calcRecommendation(cpr, targetCpr) {
  const fmtRp = n => 'Rp ' + Math.round(n).toLocaleString('id-ID');

  if (!cpr || !targetCpr) {
    return { level: 'moderate', recommendation_pct: 75, reason: 'Target CPR belum diset atau CPR tidak terbaca, gunakan penilaian manual.' };
  }

  const ratio = cpr / targetCpr;

  if (ratio <= 1) {
    return {
      level: 'good',
      recommendation_pct: 100,
      reason: `CPR ${fmtRp(cpr)} ≤ target ${fmtRp(targetCpr)} (${(ratio * 100).toFixed(0)}% dari target). Performa baik, top up penuh direkomendasikan.`
    };
  } else if (ratio <= 1.5) {
    return {
      level: 'moderate',
      recommendation_pct: 75,
      reason: `CPR ${fmtRp(cpr)} melebihi target ${fmtRp(targetCpr)} sebesar ${((ratio - 1) * 100).toFixed(0)}%. Performa cukup, top up 75% direkomendasikan.`
    };
  } else {
    return {
      level: 'poor',
      recommendation_pct: 50,
      reason: `CPR ${fmtRp(cpr)} jauh melebihi target ${fmtRp(targetCpr)} (${(ratio * 100).toFixed(0)}% dari target). Performa rendah, top up 50% direkomendasikan.`
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: halaman konfirmasi approve (aman dari WA auto-preview) ──
  if (req.method === 'GET') {
    const { action, id, token } = req.query;
    if (action !== 'approve' || !id || !token) {
      return res.status(400).send(htmlPage('⚠️', 'Link Tidak Valid', 'Parameter tidak lengkap.', '#ef4444'));
    }

    const { data: rows, error } = await sb.from('topup_requests')
      .select('*, products(name)')
      .eq('id', id)
      .eq('approve_token', token)
      .single();

    if (error || !rows) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).send(htmlPage('🔗', 'Link Tidak Valid', 'Request tidak ditemukan atau token salah.', '#ef4444'));
    }

    if (rows.status === 'approved') {
      res.setHeader('Content-Type', 'text/html');
      return res.send(htmlPage('✅', 'Sudah Disetujui', `Request dari <strong>${rows.user_name}</strong> sudah pernah disetujui.`, '#10b981'));
    }
    if (rows.status === 'rejected') {
      res.setHeader('Content-Type', 'text/html');
      return res.send(htmlPage('❌', 'Sudah Ditolak', 'Request ini sebelumnya sudah ditolak.', '#ef4444'));
    }

    const r = { ...rows, product_name: rows.products?.name || '-' };
    res.setHeader('Content-Type', 'text/html');
    return res.send(htmlConfirm(r, id, token));
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { action } = body;

  // ── BACKWARD COMPAT: kirim WA biasa (tidak ada action field) ──
  if (!action || action === 'send') {
    const { token, target, message } = body;
    const fonnteToken = token || process.env.FONNTE_TOKEN;
    const waTarget = target || process.env.WA_TARGET;
    if (!fonnteToken || !waTarget || !message) {
      return res.status(400).json({ error: 'token, target, dan message wajib diisi' });
    }
    try {
      const r2 = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: waTarget, message })
      });
      const data = await r2.json();
      if (!r2.ok || data.status === false) throw new Error(data.reason || 'Gagal kirim WA');
      return res.status(200).json({ success: true, data });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── extract_topup: Claude Vision extract screenshot Meta Ads + AI recommendation ──
  if (action === 'extract_topup') {
    const { image_base64, mime_type, target_cpr, product_name } = body;
    if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mime_type || 'image/png', data: image_base64 }
              },
              {
                type: 'text',
                text: `Kamu adalah data extractor untuk screenshot Meta Ads Manager (versi Bahasa Indonesia).

Screenshot menampilkan tabel kampanye Meta Ads. Fokus pada BARIS TOTAL di paling bawah tabel (berlabel "Hasil dari X kampanye").

Mapping kolom yang HARUS kamu ikuti (ambil dari baris total):
- "Hasil" → results (angka total lead/konversi di baris paling bawah)
- "Biaya per hasil" → cpr (angka biaya per lead di baris paling bawah, contoh: "Rp 202.214" → 202214)
- "Jumlah yang dibelanjakan" → spend (total spend di baris paling bawah, contoh: "Rp 1.617.715" → 1617715)
- Tanggal dari pojok kanan atas → date_range (contoh: "Hari Ini: 6 Okt 2026" → "6 Okt 2026")

PENTING: Semua angka kembalikan sebagai INTEGER murni. Format Indonesia: titik = pemisah ribuan, koma = desimal.
Contoh: "Rp 1.617.715" = 1617715, "Rp 202.214" = 202214, "Rp 25.000" = 25000.

Return HANYA valid JSON (tanpa markdown, tanpa komentar):
{
  "date_range": "6 Okt 2026",
  "spend": 1617715,
  "results": 8,
  "cpr": 202214
}

Field tidak ditemukan = null.`
              }
            ]
          }]
        })
      });

      const data = await resp.json();
      if (!resp.ok) return res.status(500).json({ error: 'Claude API error', detail: data });

      const text = data.content?.[0]?.text || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      try {
        const extracted = JSON.parse(match?.[0] || '{}');

        // Hitung rekomendasi di server (bukan AI) — akurat & tidak bisa salah format
        const recommendation = calcRecommendation(extracted.cpr, target_cpr);

        return res.json({ ok: true, extracted, recommendation });
      } catch {
        return res.json({ ok: false, error: 'Gagal parse AI response', raw: text });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── extract_billing: Claude Vision extract screenshot Tagihan Meta ──
  if (action === 'extract_billing') {
    const { image_base64, mime_type } = body;
    if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime_type || 'image/png', data: image_base64 } },
              { type: 'text', text: `Extract data dari screenshot halaman Tagihan & Pembayaran Meta Ads (versi Bahasa Indonesia).

Cari 2 nilai ini:
- "Saldo Saat Ini" → saldo_saat_ini (contoh: "Rp 1.831.573" → 1831573)
- "Jangkauan saldo Anda" → jangkauan_saldo (contoh: "Rp 2.716.578" → 2716578)

Format Indonesia: titik = pemisah ribuan. Return HANYA valid JSON:
{"saldo_saat_ini": 1831573, "jangkauan_saldo": 2716578}

Field tidak ditemukan = null.` }
            ]
          }]
        })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(500).json({ error: 'Claude API error' });
      const text = data.content?.[0]?.text || '{}';
      const match = text.match(/\{[\s\S]*?\}/);
      try {
        return res.json({ ok: true, extracted: JSON.parse(match?.[0] || '{}') });
      } catch {
        return res.json({ ok: false, error: 'Gagal parse response', raw: text });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── notify_topup: kirim WA ke admin/finance ──
  if (action === 'notify_topup') {
    const { request_id, user_name, product_name, nominal_request, extracted, recommendation, approve_token, ad_account_name, billing_data } = body;

    // Ambil fonnte token — cari dari siapapun yang sudah set, fallback ke env var
    const { data: cfgWithToken } = await sb.from('app_config')
      .select('fonnte_token')
      .not('fonnte_token', 'is', null)
      .neq('fonnte_token', '')
      .limit(1)
      .maybeSingle();

    const fonnteToken = cfgWithToken?.fonnte_token || process.env.FONNTE_TOKEN;
    if (!fonnteToken) return res.json({ ok: false, warn: 'Fonnte token belum dikonfigurasi di Settings → Fonnte' });

    // Ambil WA targets dari global_settings
    const { data: gs, error: gsErr } = await sb.from('global_settings')
      .select('topup_wa_targets')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .single();

    if (gsErr) return res.json({ ok: false, warn: 'global_settings error: ' + gsErr.message });

    const waTargets = gs?.topup_wa_targets || [];
    if (!waTargets.length) return res.json({ ok: false, warn: 'Belum ada nomor penerima notif top up di Settings' });

    const fmtNum = n => n != null ? Number(n).toLocaleString('id-ID') : '-';
    const baseUrl = process.env.APP_URL || 'https://adsy-autopilot.vercel.app';
    const approveLink = `${baseUrl}/api/notify-wa?action=approve&id=${request_id}&token=${approve_token}`;

    const rec = recommendation || {};
    const levelLabel = { good: 'Performa Baik ✅', moderate: 'Performa Cukup ⚠️', poor: 'Performa Rendah ❌' }[rec.level] || '-';

    // Hitung status billing
    const billing = billing_data || {};
    let billingStatus = null;
    if (billing.saldo_saat_ini != null && billing.jangkauan_saldo != null && billing.jangkauan_saldo > 0) {
      const pct = ((billing.saldo_saat_ini / billing.jangkauan_saldo) * 100).toFixed(0);
      const sisa = billing.jangkauan_saldo - billing.saldo_saat_ini;
      billingStatus = `Saldo: Rp ${fmtNum(billing.saldo_saat_ini)} / Limit: Rp ${fmtNum(billing.jangkauan_saldo)} (${pct}%) — Sisa ruang: Rp ${fmtNum(sisa)}`;
    }

    const pesan = [
      `🔔 *Request Top Up — Adsy Autopilot*`,
      ``,
      `👤 *${user_name}* minta top up:`,
      `💰 *Nominal: Rp ${fmtNum(nominal_request)}*`,
      `📦 Produk: ${product_name || '-'}`,
      ad_account_name ? `🖥️ Akun Iklan: ${ad_account_name}` : null,
      billing.kartu_kredit_nama ? `💳 Kartu: ${billing.kartu_kredit_nama} ····${billing.kartu_kredit_nomor || ''}` : null,
      ``,
      `📊 *Performa (Meta Ads):*`,
      extracted?.date_range ? `• Periode: ${extracted.date_range}` : null,
      extracted?.spend != null ? `• Spend: Rp ${fmtNum(extracted.spend)}` : null,
      extracted?.results != null ? `• Hasil (Lead): ${fmtNum(extracted.results)}` : null,
      extracted?.cpr != null ? `• CPR: Rp ${fmtNum(extracted.cpr)}` : null,
      ``,
      rec.level ? `⚡ *${levelLabel}*` : null,
      rec.recommendation_pct ? `💡 Rekomendasi performa: Top up ${rec.recommendation_pct}%` : null,
      ``,
      billingStatus ? `🏦 *Status Billing:*` : null,
      billingStatus ? `• ${billingStatus}` : null,
      ``,
      `🔗 *Approve request ini:*`,
      approveLink,
      ``,
      `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
    ].filter(l => l !== null).join('\n');

    const results = await Promise.all(
      waTargets.map(async no => {
        // Nomor sudah dalam format 62xxx dari Settings, strip non-digit saja
        const target = String(no).replace(/\D/g, '');
        try {
          const r2 = await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ target, message: pesan })
          });
          const d = await r2.json();
          return { no: target, ok: d.status !== false, result: d };
        } catch (e) {
          return { no: target, ok: false, error: e.message };
        }
      })
    );

    const allFailed = results.every(r => !r.ok);
    const anyFailed = results.some(r => !r.ok);
    const failReasons = results.filter(r => !r.ok).map(r => r.result?.reason || r.error || 'unknown').join(', ');

    if (allFailed) {
      return res.json({ ok: false, warn: 'Fonnte gagal kirim WA: ' + failReasons, results });
    }
    return res.json({ ok: true, partial: anyFailed, warn: anyFailed ? 'Sebagian gagal: ' + failReasons : null, results });
  }

  // ── approve_topup: eksekusi approve / reject ──
  if (action === 'approve_topup') {
    const { id, token, nominal_disetujui, catatan, reject } = body;
    if (!id || !token) return res.status(400).json({ error: 'id dan token diperlukan' });

    // Cek request
    const { data: req_data, error: fetchErr } = await sb.from('topup_requests')
      .select('*, products(name)')
      .eq('id', id)
      .eq('approve_token', token)
      .single();

    if (fetchErr || !req_data) return res.status(404).json({ error: 'Request tidak ditemukan atau token salah' });
    if (req_data.status !== 'pending') return res.status(400).json({ error: `Request sudah ${req_data.status}` });

    const newStatus = reject ? 'rejected' : 'approved';
    const updatePayload = {
      status: newStatus,
      catatan: catatan || null,
      updated_at: new Date().toISOString()
    };
    if (!reject && nominal_disetujui) {
      updatePayload.nominal_disetujui = Number(nominal_disetujui);
    }

    const { error: updErr } = await sb.from('topup_requests')
      .update(updatePayload)
      .eq('id', id);

    if (updErr) return res.status(500).json({ error: updErr.message });

    // Notif WA balik ke advertiser
    try {
      const { data: userCfg } = await sb.from('app_config')
        .select('wa_target')
        .eq('user_id', req_data.user_id)
        .single();

      const { data: adminCfg } = await sb.from('app_config')
        .select('fonnte_token')
        .not('fonnte_token', 'is', null)
        .limit(1)
        .maybeSingle();

      const fonnteToken = adminCfg?.fonnte_token || process.env.FONNTE_TOKEN;
      const noWa = userCfg?.wa_target;

      if (fonnteToken && noWa) {
        let target = String(noWa).replace(/\D/g, '');
        if (target.startsWith('0')) target = '62' + target.slice(1);
        else if (!target.startsWith('62')) target = '62' + target;
        const fmtNum = n => n != null ? Number(n).toLocaleString('id-ID') : '-';

        const pesan = reject
          ? [
              `❌ *Top Up Ditolak*`,
              ``,
              `Halo *${req_data.user_name}*,`,
              `Request top up kamu sebesar *Rp ${fmtNum(req_data.nominal_request)}* ditolak.`,
              catatan ? `Alasan: ${catatan}` : null,
              ``,
              `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
            ].filter(Boolean).join('\n')
          : [
              `✅ *Top Up Disetujui!*`,
              ``,
              `Halo *${req_data.user_name}*,`,
              `Request top up kamu sudah disetujui!`,
              `💰 *Nominal disetujui: Rp ${fmtNum(nominal_disetujui || req_data.nominal_request)}*`,
              catatan ? `📝 Catatan: ${catatan}` : null,
              ``,
              `Silakan cek budget Meta Ads kamu.`,
              `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
            ].filter(Boolean).join('\n');

        await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, message: pesan, countryCode: '62' })
        });
      }
    } catch (_) {}

    return res.json({ ok: true, status: newStatus });
  }

  return res.status(400).json({ error: 'Invalid action. Use: send | extract_topup | notify_topup | approve_topup' });
}
