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
    ${ext.omset != null ? `<div class="info-row"><span class="lbl">Omset</span><span class="val">Rp ${fmtNum(ext.omset)}</span></div>` : ''}
    ${ext.omset != null ? (() => {
      if (ext.caq_pct != null) {
        const caq = ext.caq_pct;
        const color = caq <= 15 ? '#10b981' : caq <= 25 ? '#f59e0b' : '#ef4444';
        const lbl = caq <= 15 ? 'Murah' : caq <= 25 ? 'Cukup' : 'Mahal';
        return `<div class="info-row"><span class="lbl">CAQ</span><span class="val" style="color:${color}">${caq.toFixed(1)}% — ${lbl}</span></div>`;
      }
      return `<div class="info-row"><span class="lbl">CAQ</span><span class="val" style="color:#6b7280">— (omset 0)</span></div>`;
    })() : ''}
  </div>

  ${(r.billing_data?.saldo_saat_ini != null || r.billing_data?.kartu_kredit_nama) ? `
  <div style="font-size:12px;font-weight:700;color:var(--text-sub,#64748b);margin-bottom:6px;margin-top:12px;">🏦 Info Billing</div>
  <div class="info">
    ${r.ad_account_name ? `<div class="info-row"><span class="lbl">Akun Iklan</span><span class="val">${r.ad_account_name}</span></div>` : ''}
    ${r.billing_data?.saldo_saat_ini != null ? `<div class="info-row"><span class="lbl">Saldo Saat Ini</span><span class="val">Rp ${fmtNum(r.billing_data.saldo_saat_ini)}</span></div>` : ''}
    ${r.billing_data?.jangkauan_saldo != null ? `<div class="info-row"><span class="lbl">Jangkauan Saldo</span><span class="val">Rp ${fmtNum(r.billing_data.jangkauan_saldo)}</span></div>` : ''}
    ${r.billing_data?.kartu_kredit_nama ? `<div class="info-row"><span class="lbl">Kartu Kredit</span><span class="val">${r.billing_data.kartu_kredit_nama} ····${r.billing_data.kartu_kredit_nomor || ''}</span></div>` : ''}
  </div>` : ''}

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
function calcRecommendation(kpiActual, kpiTarget, adType = 'form') {
  const fmtRp = n => 'Rp ' + Math.round(n).toLocaleString('id-ID');
  const label = adType === 'ctwa' ? 'CPC' : 'CPR';

  if (!kpiActual || !kpiTarget) {
    return { level: 'moderate', recommendation_pct: 75, reason: `Target ${label} belum diset atau ${label} tidak terbaca, gunakan penilaian manual.` };
  }

  const ratio = kpiActual / kpiTarget;

  if (ratio <= 1) {
    return {
      level: 'good',
      recommendation_pct: 100,
      reason: `${label} ${fmtRp(kpiActual)} ≤ target ${fmtRp(kpiTarget)} (${(ratio * 100).toFixed(0)}% dari target). Performa baik, top up penuh direkomendasikan.`
    };
  } else if (ratio <= 1.5) {
    return {
      level: 'moderate',
      recommendation_pct: 75,
      reason: `${label} ${fmtRp(kpiActual)} melebihi target ${fmtRp(kpiTarget)} sebesar ${((ratio - 1) * 100).toFixed(0)}%. Performa cukup, top up 75% direkomendasikan.`
    };
  } else {
    return {
      level: 'poor',
      recommendation_pct: 50,
      reason: `${label} ${fmtRp(kpiActual)} jauh melebihi target ${fmtRp(kpiTarget)} (${(ratio * 100).toFixed(0)}% dari target). Performa rendah, top up 50% direkomendasikan.`
    };
  }
}

// Format target WA — support nomor individu & group ID Fonnte (xxx@g.us)
function formatWaTarget(no) {
  const s = String(no).trim();
  if (s.includes('@g.us')) return s; // group ID — biarkan as-is
  const digits = s.replace(/\D/g, '');
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (!digits.startsWith('62')) return '62' + digits;
  return digits;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: halaman konfirmasi approve (aman dari WA auto-preview) ──
  if (req.method === 'GET') {
    const { action, id, token } = req.query;
    if (!id || !token) {
      return res.status(400).send(htmlPage('⚠️', 'Link Tidak Valid', 'Parameter tidak lengkap.', '#ef4444'));
    }

    // ── GET confirm_selow: halaman konfirmasi transfer Selow.id ──
    if (action === 'confirm_selow') {
      const { data: rows } = await sb.from('topup_requests')
        .select('*, products(name)').eq('id', id).eq('approve_token', token).single();
      res.setHeader('Content-Type', 'text/html');
      if (!rows) return res.status(404).send(htmlPage('🔗', 'Link Tidak Valid', 'Request tidak ditemukan atau token salah.', '#ef4444'));
      if (rows.extracted_data?.transfer_confirmed) return res.send(htmlPage('✅', 'Sudah Dikonfirmasi', `Transfer dari <strong>${rows.user_name}</strong> sudah pernah dikonfirmasi.`, '#10b981'));

      const fmtNum = n => n != null ? Number(n).toLocaleString('id-ID') : '-';
      const isBri = rows.transfer_bank === 'bri';
      const bankLabel = isBri ? 'BRI' : rows.transfer_bank === 'mandiri' ? 'Mandiri' : '-';

      // Ambil VA dari global_settings
      const { data: gs2 } = await sb.from('global_settings')
        .select('selow_va_bri, selow_va_mandiri').eq('id', '00000000-0000-0000-0000-000000000001').single();
      const va = isBri ? (gs2?.selow_va_bri || '-') : (gs2?.selow_va_mandiri || '-');

      return res.send(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Konfirmasi Transfer Selow.id</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f6fa;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}.card{background:#fff;border-radius:20px;padding:36px 28px;max-width:420px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);}h1{font-size:18px;font-weight:700;color:#1e293b;margin-bottom:4px;}.sub{font-size:13px;color:#64748b;margin-bottom:20px;}.info{background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:16px;}.row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:6px 0;border-bottom:1px solid #f1f5f9;}.row:last-child{border-bottom:none;}.lbl{color:#64748b;}.val{font-weight:600;color:#1e293b;display:flex;align-items:center;gap:8px;}.copy-btn{border:none;background:#e0f2fe;color:#0369a1;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;cursor:pointer;}.va-box{background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:12px;padding:14px 16px;margin-bottom:16px;}.va-label{font-size:11px;font-weight:700;color:#1d4ed8;margin-bottom:6px;}.va-number{font-size:20px;font-weight:800;color:#1e293b;letter-spacing:1px;}.btn{width:100%;padding:14px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;background:#10b981;color:#fff;transition:background .2s;}.btn:hover{background:#059669;}.btn:disabled{background:#94a3b8;cursor:not-allowed;}.note{font-size:11px;color:#94a3b8;text-align:center;margin-top:12px;}</style></head>
<body><div class="card">
  <h1>🔵 Konfirmasi Transfer Selow.id</h1>
  <div class="sub">Konfirmasi setelah transfer berhasil dilakukan</div>
  <div class="info">
    <div class="row"><span class="lbl">👤 Advertiser</span><span class="val">${rows.user_name}</span></div>
    <div class="row"><span class="lbl">💰 Nominal Disetujui</span><span class="val">Rp ${fmtNum(rows.nominal_disetujui)}</span></div>
    <div class="row"><span class="lbl">💸 Nominal Transfer</span><span class="val">Rp ${fmtNum(rows.nominal_transfer)} <button class="copy-btn" onclick="copyText('${rows.nominal_transfer}')">📋 Copy</button></span></div>
    <div class="row"><span class="lbl">🏦 Bank</span><span class="val">${bankLabel}</span></div>
  </div>
  <div class="va-box">
    <div class="va-label">🏦 Nomor VA ${bankLabel}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div class="va-number">${va}</div>
      <button class="copy-btn" style="font-size:13px;padding:6px 12px;" onclick="copyText('${va}')">📋 Copy VA</button>
    </div>
  </div>
  <button class="btn" id="btn-confirm" onclick="doConfirm()">✅ Konfirmasi Transfer Selesai</button>
  <div class="note" id="note">Tekan tombol setelah transfer berhasil.</div>
</div>
<script>
function copyText(t) { navigator.clipboard.writeText(String(t)).then(() => alert('Disalin!')); }
async function doConfirm() {
  const btn = document.getElementById('btn-confirm');
  btn.disabled = true; btn.textContent = 'Memproses...';
  try {
    const r = await fetch('/api/notify-wa', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'confirm_selow', id:'${id}', token:'${token}' }) });
    const d = await r.json();
    if (d.ok) { btn.textContent = '✅ Transfer Dikonfirmasi!'; document.getElementById('note').textContent = 'Kamu bisa tutup halaman ini.'; }
    else { btn.disabled = false; btn.textContent = '✅ Konfirmasi Transfer Selesai'; alert(d.error || 'Gagal'); }
  } catch(e) { btn.disabled = false; btn.textContent = '✅ Konfirmasi Transfer Selesai'; alert('Error: ' + e.message); }
}
</script></body></html>`);
    }

    // ── GET approve: halaman konfirmasi approve (default) ──
    if (action !== 'approve') {
      return res.status(400).send(htmlPage('⚠️', 'Link Tidak Valid', 'Action tidak dikenali.', '#ef4444'));
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
    const { image_base64, mime_type, target_kpi, target_cpr, product_name, ad_type } = body;
    if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const isCtwa = ad_type === 'ctwa';
    const effectiveTarget = target_kpi || target_cpr; // backward compat
    const resultsLabel = isCtwa ? 'percakapan/chat yang dimulai' : 'lead/konversi';
    const kpiLabel = isCtwa ? 'CPC (cost per chat)' : 'CPR (cost per lead)';

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
                text: `Ekstrak data dari screenshot Meta Ads Manager.

Cari baris paling bawah bertulisan "Hasil dari X kampanye".

Urutan kolom di tabel Meta Ads dari kiri ke kanan adalah:
No. | Kampanye | Hasil | Jangkauan | Frekuensi | Biaya per hasil | Anggaran | Jumlah yang dibelanjakan | Omset | CAQ

Dari baris "Hasil dari X kampanye", baca:
1. Kolom ke-3 = "Hasil" → results. Tiap sel di kolom ini menampilkan 2 baris: baris atas = angka atau "—", baris bawah = nama event (abaikan). Jika baris atas "—" → null.
2. Kolom ke-6 = "${isCtwa ? 'Biaya per klik (semua)' : 'Biaya per hasil'}" → ${isCtwa ? 'cpc' : 'cpr'}. Jika "—" → null.
3. Kolom ke-8 = "Jumlah yang dibelanjakan" → spend. Jika "—" → null.
4. Tanggal di pojok kanan atas → date_range.

INGAT: kolom ke-4 "Jangkauan" adalah reach/jangkauan audiens — BUKAN hasil konversi, jangan masukkan ke results.

Angka format Indonesia: "Rp 49.947" = 49947 (integer, tanpa titik).

Return JSON saja:
${isCtwa ? '{"date_range":"...","spend":...,"results":...,"cpc":...}' : '{"date_range":"...","spend":...,"results":...,"cpr":...}'}`
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
        const kpiActual = isCtwa ? extracted.cpc : extracted.cpr;
        const recommendation = calcRecommendation(kpiActual, effectiveTarget, ad_type || 'form');
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
    const { request_id, user_name, product_name, nominal_request, extracted, recommendation, approve_token, ad_account_name, billing_data, topup_time } = body;

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

    const timeLabel = topup_time === 'sore' ? '🌆 Top Up Sore (spend hari ini)' : '🌅 Top Up Pagi (spend kemarin)';

    const pesan = [
      `🔔 *Request Top Up — Adsy Autopilot*`,
      `${timeLabel}`,
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
      extracted?.omset != null ? `• Omset: Rp ${fmtNum(extracted.omset)}` : null,
      extracted?.omset != null ? (extracted?.caq_pct != null ? (() => {
        const caq = extracted.caq_pct;
        const lbl = caq <= 15 ? 'Murah ✅' : caq <= 25 ? 'Cukup ⚠️' : 'Mahal ❌';
        return `• CAQ: ${caq.toFixed(1)}% — ${lbl}`;
      })() : `• CAQ: — (omset 0)`) : null,
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
        const target = formatWaTarget(no);
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

    // Update saldo akun iklan dari spend (jika request punya ad_account_id dan spend terdeteksi)
    const adAccountId = body.ad_account_id;
    const spend = Number(extracted?.spend) || 0;
    const topupTime = body.topup_time || 'pagi';

    if (adAccountId && spend > 0) {
      try {
        let spendToRecord = spend;
        let skipReason = null;

        // Semua tanggal pakai WIB (UTC+7) biar konsisten dengan laporan advertiser
        const WIB_MS = 7 * 60 * 60 * 1000;
        const todayWIB    = new Date(Date.now() + WIB_MS).toISOString().slice(0, 10);
        const yesterdayWIB = new Date(Date.now() + WIB_MS - 86400000).toISOString().slice(0, 10);
        const todayStart     = `${todayWIB}T00:00:00+07:00`;
        const yesterdayStart = `${yesterdayWIB}T00:00:00+07:00`;
        const yesterdayEnd   = `${yesterdayWIB}T23:59:59+07:00`;

        if (topupTime === 'sore') {
          // SS Sore cumulative dari 00:00 — ambil delta dari sore sebelumnya hari ini
          // (exclude rejected supaya Sore yg ditolak tidak ikut mengurangi)
          const { data: lastSore } = await sb
            .from('topup_requests')
            .select('extracted_data')
            .eq('topup_ad_account_id', adAccountId)
            .eq('topup_time', 'sore')
            .neq('id', body.request_id)
            .neq('status', 'rejected')
            .gte('created_at', todayStart)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          const lastSpend = Number(lastSore?.extracted_data?.spend) || 0;
          spendToRecord = Math.max(0, spend - lastSpend);

        } else if (topupTime === 'pagi') {
          // Bug 3 fix: cek apakah sudah ada Pagi hari ini untuk akun ini (bukan rejected)
          // Kalau ada → skip, sudah tercatat sebelumnya
          const { data: existingPagi } = await sb
            .from('topup_requests')
            .select('id')
            .eq('topup_ad_account_id', adAccountId)
            .eq('topup_time', 'pagi')
            .neq('id', body.request_id)
            .neq('status', 'rejected')
            .gte('created_at', todayStart)
            .limit(1)
            .maybeSingle();

          if (existingPagi) {
            skipReason = 'Pagi sudah tercatat hari ini untuk akun ini';
            spendToRecord = 0;
          } else {
            // Bug 2 fix: hanya kurangi dari Sore kemarin yang TIDAK ditolak
            const { data: lastSoreYesterday } = await sb
              .from('topup_requests')
              .select('extracted_data')
              .eq('topup_ad_account_id', adAccountId)
              .eq('topup_time', 'sore')
              .neq('status', 'rejected')
              .gte('created_at', yesterdayStart)
              .lte('created_at', yesterdayEnd)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            const alreadyRecorded = Number(lastSoreYesterday?.extracted_data?.spend) || 0;
            spendToRecord = Math.max(0, spend - alreadyRecorded);
          }
        }

        const catatanLog = skipReason
          ? `[Skip] ${skipReason}`
          : topupTime === 'sore'
            ? `Spend sore (Rp ${spend.toLocaleString('id-ID')} total, delta +Rp ${spendToRecord.toLocaleString('id-ID')})`
            : spendToRecord < spend
              ? `Spend pagi kemarin (Rp ${spend.toLocaleString('id-ID')} full day, delta +Rp ${spendToRecord.toLocaleString('id-ID')} setelah dikurangi sore kemarin)`
              : `Spend ${extracted?.date_range || 'kemarin'}`;

        if (spendToRecord > 0) {
          const { data: acct } = await sb.from('topup_ad_accounts').select('saldo_saat_ini').eq('id', adAccountId).single();
          const newSaldo = (Number(acct?.saldo_saat_ini) || 0) + spendToRecord;
          await sb.from('topup_ad_accounts').update({ saldo_saat_ini: newSaldo, updated_at: new Date().toISOString() }).eq('id', adAccountId);
          await sb.from('topup_ad_account_logs').insert({
            ad_account_id: adAccountId,
            type: 'spend',
            amount: spendToRecord,
            request_id: body.request_id,
            catatan: catatanLog,
            tanggal: todayWIB
          });
        }
      } catch (_) {}
    }

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

    // Helper tanggal WIB untuk log
    const todayWIBLog = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Update saldo akun iklan saat approve (kurangi nominal_disetujui)
    if (!reject && nominal_disetujui && req_data.topup_ad_account_id) {
      try {
        const { data: acct } = await sb.from('topup_ad_accounts').select('saldo_saat_ini').eq('id', req_data.topup_ad_account_id).single();
        const newSaldo = Math.max(0, (Number(acct?.saldo_saat_ini) || 0) - Number(nominal_disetujui));
        await sb.from('topup_ad_accounts').update({ saldo_saat_ini: newSaldo, updated_at: new Date().toISOString() }).eq('id', req_data.topup_ad_account_id);
        await sb.from('topup_ad_account_logs').insert({
          ad_account_id: req_data.topup_ad_account_id,
          type: 'topup',
          amount: -Number(nominal_disetujui),
          request_id: req_data.id,
          catatan: 'Top up disetujui',
          tanggal: todayWIBLog
        });
      } catch (_) {}
    }

    // Reverse saldo saat ditolak (batalkan spend yang sudah direcord saat submit)
    if (reject && req_data.topup_ad_account_id) {
      try {
        const { data: spendLog } = await sb.from('topup_ad_account_logs')
          .select('amount')
          .eq('request_id', req_data.id)
          .eq('type', 'spend')
          .limit(1)
          .maybeSingle();

        if (spendLog?.amount > 0) {
          const { data: acct } = await sb.from('topup_ad_accounts').select('saldo_saat_ini').eq('id', req_data.topup_ad_account_id).single();
          const newSaldo = Math.max(0, (Number(acct?.saldo_saat_ini) || 0) - spendLog.amount);
          await sb.from('topup_ad_accounts').update({ saldo_saat_ini: newSaldo, updated_at: new Date().toISOString() }).eq('id', req_data.topup_ad_account_id);
          await sb.from('topup_ad_account_logs').insert({
            ad_account_id: req_data.topup_ad_account_id,
            type: 'spend_reversed',
            amount: -spendLog.amount,
            request_id: req_data.id,
            catatan: 'Request ditolak — spend di-reverse',
            tanggal: todayWIBLog
          });
        }
      } catch (_) {}
    }

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
        const target = formatWaTarget(noWa);
        const fmtNum = n => n != null ? Number(n).toLocaleString('id-ID') : '-';

        const isSelow = req_data.extracted_data?.payment_method === 'selow';
        const approvedNominal = fmtNum(nominal_disetujui || req_data.nominal_request);

        const pesan = reject
          ? [
              `⚠️ *Top Up Tidak Disetujui*`,
              ``,
              `Halo *${req_data.user_name}*,`,
              `Mohon maaf, request top up kamu sebesar *Rp ${fmtNum(req_data.nominal_request)}* belum bisa kami setujui saat ini.`,
              catatan ? `\n📝 *Keterangan:*\n${catatan}` : null,
              ``,
              `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
            ].filter(Boolean).join('\n')
          : [
              `✅ *Top Up Disetujui!*`,
              ``,
              `Halo *${req_data.user_name}*,`,
              `Request top up kamu sudah disetujui!`,
              `💰 *Nominal disetujui: Rp ${approvedNominal}*`,
              catatan ? `\n📝 Catatan: ${catatan}` : null,
              ``,
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

  // ── notify_selow_transfer: WA ke finance dengan nominal transfer dari Selow.id ──
  if (action === 'notify_selow_transfer') {
    const { request_id, user_name, nominal_disetujui, nominal_transfer, transfer_bank, ad_account_name, billing_data } = body;

    // Update DB pakai service key (bypass RLS)
    if (request_id && nominal_transfer && transfer_bank) {
      const { error: updErr } = await sb.from('topup_requests')
        .update({ nominal_transfer: Number(nominal_transfer), transfer_bank, updated_at: new Date().toISOString() })
        .eq('id', request_id);
      if (updErr) return res.status(500).json({ error: 'Gagal simpan nominal: ' + updErr.message });
    }

    const { data: cfgWithToken } = await sb.from('app_config')
      .select('fonnte_token').not('fonnte_token', 'is', null).neq('fonnte_token', '').limit(1).maybeSingle();
    const fonnteToken = cfgWithToken?.fonnte_token || process.env.FONNTE_TOKEN;
    if (!fonnteToken) return res.json({ ok: false, warn: 'Fonnte token belum dikonfigurasi' });

    const { data: gs } = await sb.from('global_settings')
      .select('topup_wa_targets, selow_va_bri, selow_va_mandiri, selow_wa_group').eq('id', '00000000-0000-0000-0000-000000000001').single();
    // Kalau selow_wa_group diset, kirim ke group itu saja; kalau tidak, fallback ke topup_wa_targets
    const waTargets = gs?.selow_wa_group
      ? [gs.selow_wa_group]
      : (gs?.topup_wa_targets || []);
    if (!waTargets.length) return res.json({ ok: false, warn: 'Belum ada nomor/group penerima notif Selow di Settings' });

    // Ambil approve_token dari request untuk buat confirm link
    let confirmLink = null;
    if (request_id) {
      const { data: reqRow } = await sb.from('topup_requests').select('approve_token').eq('id', request_id).single();
      if (reqRow?.approve_token) {
        const baseUrl = process.env.APP_URL || 'https://adsy-autopilot.vercel.app';
        confirmLink = `${baseUrl}/api/notify-wa?action=confirm_selow&id=${request_id}&token=${reqRow.approve_token}`;
      }
    }

    const selowVaBri = gs?.selow_va_bri || null;
    const selowVaMandiri = gs?.selow_va_mandiri || null;
    const fmtNum = n => n != null ? Number(n).toLocaleString('id-ID') : '-';
    const bd = billing_data || {};
    const isBri = transfer_bank === 'bri';
    const va = isBri ? selowVaBri : selowVaMandiri;
    const bankName = isBri ? 'BRI' : 'Mandiri';

    const pesan = [
      `🔵 *Selow.id — Siap Transfer*`,
      ``,
      `👤 Advertiser: *${user_name}*`,
      ad_account_name ? `🖥️ Akun Iklan: ${ad_account_name}` : null,
      bd.kartu_kredit_nama ? `💳 Kartu: ${bd.kartu_kredit_nama} ····${bd.kartu_kredit_nomor || ''}` : null,
      ``,
      `✅ Disetujui: Rp ${fmtNum(nominal_disetujui)}`,
      `💰 *Nominal Transfer: Rp ${fmtNum(nominal_transfer)}*`,
      va ? `🏦 *Transfer via ${bankName}: ${va}*` : `🏦 Bank: ${bankName} (VA belum diset di Settings)`,
      ``,
      confirmLink ? `🔗 Konfirmasi setelah transfer:\n${confirmLink}` : null,
      `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
    ].filter(Boolean).join('\n');

    const results = await Promise.all(waTargets.map(async no => {
      const target = formatWaTarget(no);
      try {
        const r2 = await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, message: pesan })
        });
        const d = await r2.json();
        return { no: target, ok: d.status !== false };
      } catch (e) { return { no: target, ok: false }; }
    }));

    const allFailed = results.every(r => !r.ok);
    return res.json({ ok: !allFailed });
  }

  // ── confirm_selow: finance konfirmasi transfer sudah dilakukan ──
  if (action === 'confirm_selow') {
    const { id, token } = body;
    if (!id || !token) return res.status(400).json({ error: 'id dan token diperlukan' });

    const { data: req_data } = await sb.from('topup_requests')
      .select('*, extracted_data, approve_token').eq('id', id).eq('approve_token', token).single();
    if (!req_data) return res.status(404).json({ error: 'Request tidak ditemukan atau token salah' });
    if (req_data.extracted_data?.transfer_confirmed) return res.json({ ok: true, already: true });

    const newExt = { ...(req_data.extracted_data || {}), transfer_confirmed: true, transfer_confirmed_at: new Date().toISOString() };
    const { error } = await sb.from('topup_requests').update({ extracted_data: newExt, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    // Kirim notif WA ke advertiser
    try {
      const { data: userCfg } = await sb.from('app_config').select('wa_target').eq('user_id', req_data.user_id).single();
      const { data: adminCfg } = await sb.from('app_config').select('fonnte_token').not('fonnte_token', 'is', null).limit(1).maybeSingle();
      const fonnteToken = adminCfg?.fonnte_token || process.env.FONNTE_TOKEN;
      const noWa = userCfg?.wa_target;

      if (fonnteToken && noWa) {
        const target = formatWaTarget(noWa);

        const fmtNum = n => n != null ? Number(n).toLocaleString('id-ID') : '-';
        const pesan = [
          `✅ *Transfer Budget Selesai!*`,
          ``,
          `Halo *${req_data.user_name}*,`,
          `Finance sudah melakukan transfer budget ke akun Meta Ads kamu.`,
          `💰 *Nominal: Rp ${fmtNum(req_data.nominal_disetujui || req_data.nominal_request)}*`,
          ``,
          `Silakan cek kartu dan lakukan pembayaran ke Meta Ads.`,
          `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
        ].join('\n');

        await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, message: pesan, countryCode: '62' })
        });
      }
    } catch (_) {}

    return res.json({ ok: true });
  }

  // ── notify_kartu_request: notif WA ke admin saat advertiser request kartu baru ──
  if (action === 'notify_kartu_request') {
    const { user_name, nama, kebutuhan, jumlah } = body;

    const { data: cfgWithToken } = await sb.from('app_config')
      .select('fonnte_token').not('fonnte_token', 'is', null).neq('fonnte_token', '').limit(1).maybeSingle();
    const fonnteToken = cfgWithToken?.fonnte_token || process.env.FONNTE_TOKEN;
    if (!fonnteToken) return res.json({ ok: false, warn: 'Fonnte token belum dikonfigurasi' });

    const { data: gs } = await sb.from('global_settings')
      .select('topup_wa_targets').eq('id', '00000000-0000-0000-0000-000000000001').single();
    const waTargets = gs?.topup_wa_targets || [];
    if (!waTargets.length) return res.json({ ok: false, warn: 'Belum ada nomor penerima notif di Settings' });

    const pesan = [
      `💳 *Request Kartu Baru — Adsy Autopilot*`,
      ``,
      `👤 *${user_name}* mengajukan request kartu:`,
      `📛 Nama: ${nama}`,
      `🔢 Jumlah: ${jumlah} kartu`,
      `📝 Kebutuhan: ${kebutuhan}`,
      ``,
      `Silakan cek di menu Top Up → Manajemen Kartu untuk merespons.`,
      ``,
      `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
    ].join('\n');

    const results = await Promise.all(waTargets.map(async no => {
      const target = formatWaTarget(no);
      try {
        const r2 = await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, message: pesan })
        });
        const d = await r2.json();
        return { no: target, ok: d.status !== false };
      } catch (e) { return { no: target, ok: false }; }
    }));

    return res.json({ ok: results.some(r => r.ok) });
  }

  // ── notify_kartu_info: notif WA ke advertiser saat admin approve/tolak request kartu ──
  if (action === 'notify_kartu_info') {
    const { user_id, user_name, nama, jumlah, status, catatan } = body;

    const { data: userCfg } = await sb.from('app_config').select('wa_target').eq('user_id', user_id).single();
    const { data: adminCfg } = await sb.from('app_config').select('fonnte_token').not('fonnte_token', 'is', null).limit(1).maybeSingle();
    const fonnteToken = adminCfg?.fonnte_token || process.env.FONNTE_TOKEN;
    const noWa = userCfg?.wa_target;
    if (!fonnteToken || !noWa) return res.json({ ok: false, warn: 'Fonnte token atau nomor WA advertiser tidak ditemukan' });

    const target = formatWaTarget(noWa);
    const pesan = status === 'ditolak'
      ? [
          `⚠️ *Request Kartu Tidak Disetujui*`,
          ``,
          `Halo *${user_name}*,`,
          `Mohon maaf, request kartu kamu belum bisa kami proses saat ini.`,
          `📛 Nama: ${nama} · 🔢 ${jumlah} kartu`,
          catatan ? `\n📝 *Keterangan:*\n${catatan}` : null,
          ``,
          `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
        ].filter(Boolean).join('\n')
      : [
          `✅ *Kartu Sudah Dibuat!*`,
          ``,
          `Halo *${user_name}*,`,
          `Request kartu kamu sudah diproses oleh admin.`,
          `📛 Nama: ${nama} · 🔢 ${jumlah} kartu`,
          ``,
          `Silakan hubungi admin untuk info lebih lanjut.`,
          ``,
          `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
        ].join('\n');

    try {
      const r2 = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, message: pesan, countryCode: '62' })
      });
      const d = await r2.json();
      return res.json({ ok: d.status !== false });
    } catch (e) {
      return res.json({ ok: false, warn: e.message });
    }
  }

  // ── chat_message: notif WA ke admin saat advertiser kirim pesan ──
  if (action === 'chat_message') {
    const { sender_name, message_preview } = body;

    const { data: cfgWithToken } = await sb.from('app_config')
      .select('fonnte_token').not('fonnte_token', 'is', null).neq('fonnte_token', '').limit(1).maybeSingle();
    const fonnteToken = cfgWithToken?.fonnte_token || process.env.FONNTE_TOKEN;
    if (!fonnteToken) return res.json({ ok: false, warn: 'Fonnte token belum dikonfigurasi' });

    const { data: gs } = await sb.from('global_settings')
      .select('topup_wa_targets').eq('id', '00000000-0000-0000-0000-000000000001').single();
    const waTargets = gs?.topup_wa_targets || [];
    if (!waTargets.length) return res.json({ ok: false, warn: 'Belum ada nomor penerima notif di Settings' });

    const baseUrl = process.env.APP_URL || 'https://adsy-autopilot.vercel.app';
    const pesan = [
      `💬 *Pesan Baru — Adsy Autopilot*`,
      ``,
      `👤 *${sender_name}* mengirim pesan:`,
      `_"${message_preview}"_`,
      ``,
      `Balas di: ${baseUrl}/chat.html`,
      `_${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}_`
    ].join('\n');

    const results = await Promise.all(waTargets.map(async no => {
      const target = formatWaTarget(no);
      try {
        const r2 = await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, message: pesan })
        });
        const d = await r2.json();
        return { no: target, ok: d.status !== false };
      } catch (e) { return { no: target, ok: false }; }
    }));

    return res.json({ ok: results.some(r => r.ok) });
  }

  return res.status(400).json({ error: 'Invalid action. Use: send | extract_topup | notify_topup | approve_topup | notify_selow_transfer | confirm_selow | notify_kartu_request | notify_kartu_info | chat_message' });
}
