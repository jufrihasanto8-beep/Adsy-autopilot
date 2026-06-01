// api/notify-wa.js — Kirim notifikasi WhatsApp via Fonnte
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, target, message } = req.body;

  const fonnteToken = token || process.env.FONNTE_TOKEN;
  const waTarget = target || process.env.WA_TARGET;

  if (!fonnteToken || !waTarget || !message) {
    return res.status(400).json({ error: 'token, target, dan message wajib diisi' });
  }

  try {
    const res2 = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        'Authorization': fonnteToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ target: waTarget, message })
    });

    const data = await res2.json();
    if (!res2.ok || data.status === false) {
      throw new Error(data.reason || 'Gagal kirim WA');
    }

    return res.status(200).json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
