// api/create-ad.js — Upload konten ke Meta + buat iklan
import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Parse multipart form
    const form = formidable({ maxFileSize: 200 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const file = files.file?.[0];
    const fileType = fields.file_type?.[0];
    const headline = fields.headline?.[0];
    const primaryText = fields.primary_text?.[0];
    const description = fields.description?.[0];
    const productId = fields.product_id?.[0];
    const adAccountDbId = fields.ad_account_db_id?.[0];
    const urlId = fields.url_id?.[0];
    const cta = fields.cta?.[0] || 'LEARN_MORE';
    const userId = fields.user_id?.[0];

    if (!file || !headline || !primaryText) {
      return res.status(400).json({ error: 'File, headline, dan primary text wajib ada' });
    }

    // Get ad account config
    const { data: accData } = await sb.from('ad_accounts')
      .select('account_id, page_id, pixel_id').eq('id', adAccountDbId).single();
    if (!accData) throw new Error('Ad account tidak ditemukan');

    const { data: urlData } = await sb.from('ad_urls').select('url').eq('id', urlId).single();

    const { data: cfgData } = await sb.from('app_config')
      .select('meta_token').eq('user_id', userId).single();

    const token = cfgData?.meta_token || process.env.META_ACCESS_TOKEN;
    const accountId = accData.account_id;
    const pageId = accData.page_id;
    const pixelId = accData.pixel_id || null;
    const destUrl = urlData?.url || 'https://wa.me/';

    if (!token) throw new Error('Meta access token belum dikonfigurasi di Pengaturan');

    let creativeId;

    if (fileType === 'video') {
      // ── Upload Video ke Meta ──
      const videoForm = new FormData();
      videoForm.append('file', fs.createReadStream(file.filepath), {
        filename: file.originalFilename,
        contentType: file.mimetype
      });
      videoForm.append('access_token', token);

      const videoRes = await fetch(`${META_API}/${accountId}/advideos`, {
        method: 'POST',
        body: videoForm,
        headers: videoForm.getHeaders()
      });
      const videoData = await videoRes.json();
      if (videoData.error) throw new Error(videoData.error.message);

      // Create video creative
      const creativeRes = await fetch(`${META_API}/${accountId}/adcreatives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Creative - ${headline}`,
          object_story_spec: {
            page_id: pageId,
            video_data: {
              video_id: videoData.id,
              title: headline,
              message: primaryText,
              call_to_action: { type: ctaMap(cta), value: { link: destUrl } }
            }
          },
          access_token: token
        })
      });
      const creativeData = await creativeRes.json();
      if (creativeData.error) throw new Error(creativeData.error.message);
      creativeId = creativeData.id;

    } else {
      // ── Upload Gambar ke Meta ──
      const imgForm = new FormData();
      imgForm.append('filename', fs.createReadStream(file.filepath), {
        filename: file.originalFilename,
        contentType: file.mimetype
      });
      imgForm.append('access_token', token);

      const imgRes = await fetch(`${META_API}/${accountId}/adimages`, {
        method: 'POST',
        body: imgForm,
        headers: imgForm.getHeaders()
      });
      const imgData = await imgRes.json();
      if (imgData.error) throw new Error(imgData.error.message);

      const imageHash = Object.values(imgData.images || {})[0]?.hash;
      if (!imageHash) throw new Error('Gagal upload gambar ke Meta');

      // Create image creative
      const creativeRes = await fetch(`${META_API}/${accountId}/adcreatives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Creative - ${headline}`,
          object_story_spec: {
            page_id: pageId,
            link_data: {
              image_hash: imageHash,
              link: destUrl,
              message: primaryText,
              name: headline,
              description: description || '',
              call_to_action: { type: ctaMap(cta) }
            }
          },
          ...(pixelId ? { pixel_id: pixelId } : {}),
          access_token: token
        })
      });
      const creativeData = await creativeRes.json();
      if (creativeData.error) throw new Error(creativeData.error.message);
      creativeId = creativeData.id;
    }

    // Get product info
    const { data: product } = await sb.from('products').select('name').eq('id', productId).single();

    // Save campaign record to Supabase
    const { data: campaign } = await sb.from('campaigns').insert({
      user_id: userId,
      name: `${product?.name || 'Iklan'} - ${headline}`,
      meta_creative_id: creativeId,
      ad_account_id: accountId,
      status: 'ACTIVE',
      current_phase: 1,
      autopilot_enabled: true,
      product_id: productId
    }).select().single();

    // Save ad copy
    await sb.from('ad_copies').insert({
      campaign_id: campaign?.id,
      user_id: userId,
      headline,
      primary_text: primaryText,
      description: description || '',
      status: 'active'
    });

    // Log
    await sb.from('action_logs').insert({
      user_id: userId,
      campaign_name: `${product?.name || 'Iklan'} - ${headline}`,
      action_type: 'create',
      description: `Iklan baru berhasil dipublish ke Meta`,
      status: 'success'
    });

    // Cleanup temp file
    fs.unlink(file.filepath, () => {});

    return res.status(200).json({ success: true, creative_id: creativeId });
  } catch (err) {
    console.error('create-ad error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function ctaMap(cta) {
  const map = {
    'Hubungi Sekarang': 'CONTACT_US',
    'Pesan Sekarang': 'ORDER_NOW',
    'Ambil Promo': 'GET_OFFER',
    'Beli Sekarang': 'SHOP_NOW',
    'Daftar Gratis': 'SIGN_UP',
    'Pelajari Lebih': 'LEARN_MORE'
  };
  return map[cta] || 'LEARN_MORE';
}
