// api/notify-new-user.js
// Kirim WA notif ke admin saat ada user baru daftar
// Kirim WA notif ke user saat akun diapprove

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, name, email, wa_number } = req.body;

  try {
    // Ambil config admin (ambil yang punya role admin pertama)
    const { data: adminProfile } = await sb.from('profiles')
      .select('id').in('role', ['admin', 'superadmin']).limit(1).single();

    if (!adminProfile) return res.status(200).json({ ok: true, note: 'No admin found' });

    const { data: cfg } = await sb.from('app_config')
      .select('fonnte_token, wa_number').eq('user_id', adminProfile.id).single();

    if (!cfg?.fonnte_token) return res.status(200).json({ ok: true, note: 'No fonnte token' });

    if (type === 'approved') {
      // Notif ke user yang baru diapprove
      if (!wa_number) return res.status(200).json({ ok: true, note: 'No WA number' });
      await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': cfg.fonnte_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: wa_number,
          message: `✅ *Akun Adsy Autopilot Disetujui!*\n\nHai ${name}! Akunmu sudah diaktifkan oleh admin.\n\nSilakan login sekarang di:\nhttps://adsy-autopilot.vercel.app\n\nSelamat menggunakan Adsy Autopilot! 🚀`
        })
      });
    } else {
      // Notif ke admin bahwa ada pendaftar baru
      if (!cfg.wa_number) return res.status(200).json({ ok: true, note: 'No admin WA' });
      await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': cfg.fonnte_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: cfg.wa_number,
          message: `👤 *Pendaftar Baru!*\n\nNama: *${name}*\nEmail: ${email}\n\nAkun menunggu persetujuanmu.\nBuka menu Kelola User untuk approve.`
        })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('notify-new-user error:', err.message);
    return res.status(200).json({ ok: true, note: err.message }); // non-fatal
  }
}
