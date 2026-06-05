// api/ai-copy.js — Generate copy iklan dengan Claude AI
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  // ── ANALISA WINNER ──
  if (action === 'analyze-winners') {
    const { winners } = req.body;
    if (!winners?.length) return res.status(400).json({ error: 'Tidak ada data winner' });

    const winnerText = winners.map((w, i) => {
      const kpis = [];
      if (w.cpr) kpis.push(`CPR: Rp ${Number(w.cpr).toLocaleString('id-ID')}`);
      if (w.ctr) kpis.push(`CTR: ${w.ctr}%`);
      if (w.campCount) kpis.push(`Dipakai di ${w.campCount} kampanye`);
      if (w.isWinner) kpis.push(`🏆 Winner`);
      return `${i+1}. [${w.type === 'video' ? 'VIDEO' : 'GAMBAR'}] ${w.name}
   Kategori: ${w.category || '-'} | Audience: ${w.audience || '-'}
   KPI: ${kpis.join(' | ')}
   ${w.notes ? `Catatan: ${w.notes}` : ''}`;
    }).join('\n\n');

    const prompt = `Kamu adalah analis performa iklan Meta Ads berpengalaman di Indonesia.

Berikut konten iklan TERBAIK (winner/performa terbaik) dari library tim ini:

${winnerText}

Analisa pola dari data ini. Jawab dalam Bahasa Indonesia yang singkat dan actionable.

Output JSON:
{
  "summary": "1-2 kalimat ringkasan pola utama winner",
  "insights": [
    "insight spesifik 1 tentang pola yang terlihat",
    "insight spesifik 2",
    "insight spesifik 3"
  ],
  "recommendations": [
    {
      "title": "Judul rekomendasi konten baru",
      "type": "image atau video",
      "description": "Penjelasan singkat konten seperti apa yang harus dibuat",
      "why": "Kenapa ini kemungkinan besar akan perform bagus berdasarkan pola winner"
    },
    {
      "title": "...",
      "type": "...",
      "description": "...",
      "why": "..."
    },
    {
      "title": "...",
      "type": "...",
      "description": "...",
      "why": "..."
    }
  ],
  "avoid": "1 kalimat tentang pola yang sebaiknya dihindari berdasarkan data"
}

PENTING: Output HANYA JSON, tanpa penjelasan tambahan.`;

    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      });
      const rawText = message.content[0].text.trim();
      const jsonStr = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const result = JSON.parse(jsonStr);
      return res.status(200).json({ success: true, result });
    } catch (err) {
      console.error('analyze-winners error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  const { product, audience, benefit, tone, objective, cta, promo,
    restrictions, notes, extra_brief, content_type, single_variant } = req.body;

  if (!product || !benefit) {
    return res.status(400).json({ error: 'product dan benefit wajib diisi' });
  }

  const variantCount = single_variant ? 1 : 3;
  const mediaNote = content_type === 'video' ? 'Copy ini untuk iklan VIDEO — teks harus kuat karena video akan autoplay.' : '';

  const toneGuide = {
    santai: 'bahasa santai, akrab, pakai kata "kamu", informal tapi sopan',
    profesional: 'bahasa formal, profesional, terpercaya, dan meyakinkan',
    hype: 'energetik, excited, pakai banyak urgensi seperti "SEKARANG", "TERBATAS", "JANGAN SAMPAI KETINGGALAN"',
    emosional: 'menyentuh hati, empati, relate dengan masalah audience, storytelling singkat',
    informatif: 'faktual, jelas, to-the-point, highlight fitur dan manfaat secara konkret'
  };

  const objectiveGuide = {
    traffic: 'dorong klik ke website/landing page',
    leads: 'ajak hubungi via WA/DM untuk info lebih lanjut',
    sales: 'dorong pembelian langsung sekarang',
    awareness: 'kenalkan brand dan produk, bangun kepercayaan'
  };

  const prompt = `Kamu adalah copywriter iklan Meta (Facebook/Instagram) terbaik di Indonesia.

Buat ${variantCount} variasi copy iklan untuk:
- Produk/Layanan: ${product}
- Target Audience: ${audience || 'umum'}
- Keunggulan/Benefit: ${benefit}
- Tone: ${toneGuide[tone] || tone}
- Tujuan Iklan: ${objectiveGuide[objective] || objective || 'penjualan'}
- CTA: ${cta || 'Hubungi Sekarang'}
${promo ? `- Promo/Penawaran: ${promo}` : ''}
${restrictions ? `- JANGAN sebut: ${restrictions}` : ''}
${notes ? `- Catatan tambahan: ${notes}` : ''}
${extra_brief ? `- Brief hari ini: ${extra_brief}` : ''}
${mediaNote}

Untuk SETIAP variasi, berikan:
1. headline (maks 40 karakter, catchy & langsung)
2. primary_text (150-300 karakter, engaging, ada hook di kalimat pertama, gunakan emoji secukupnya)
3. description (maks 30 karakter, pendek & jelas)

${variantCount > 1 ? 'Buat setiap variasi dengan pendekatan berbeda (benefit-focused, problem-solution, social proof/FOMO).' : 'Buat 1 variasi terbaik.'}

Format output JSON array:
[
  {
    "headline": "...",
    "primary_text": "...",
    "description": "...",
    "tone": "nama pendekatan"
  }
]

PENTING: Output HANYA JSON, tanpa penjelasan tambahan.`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const rawText = message.content[0].text.trim();

    // Parse JSON
    let copies;
    try {
      // Handle if wrapped in code blocks
      const jsonStr = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      copies = JSON.parse(jsonStr);
    } catch {
      throw new Error('Gagal parse response AI');
    }

    return res.status(200).json({ success: true, copies });
  } catch (err) {
    console.error('ai-copy error:', err);
    return res.status(500).json({ error: err.message });
  }
}
