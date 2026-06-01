// api/ai-copy.js — Generate copy iklan dengan Claude AI
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { product, audience, benefit, tone, objective, cta, promo } = req.body;

  if (!product || !benefit) {
    return res.status(400).json({ error: 'product dan benefit wajib diisi' });
  }

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

Buat 3 variasi copy iklan untuk:
- Produk/Layanan: ${product}
- Target Audience: ${audience || 'umum'}
- Keunggulan/Benefit: ${benefit}
- Tone: ${toneGuide[tone] || tone}
- Tujuan Iklan: ${objectiveGuide[objective] || objective}
- CTA: ${cta || 'Hubungi Sekarang'}
${promo ? `- Promo/Penawaran: ${promo}` : ''}

Untuk SETIAP variasi, berikan:
1. headline (maks 40 karakter, catchy & langsung)
2. primary_text (150-250 karakter, engaging, ada hook di kalimat pertama)
3. description (maks 30 karakter, pendek & jelas)

Buat setiap variasi dengan pendekatan berbeda (misal: benefit-focused, problem-solution, social proof/FOMO).

Format output JSON array:
[
  {
    "headline": "...",
    "primary_text": "...",
    "description": "...",
    "tone": "nama pendekatan"
  },
  ...
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
