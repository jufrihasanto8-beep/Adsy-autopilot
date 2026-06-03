// api/create-ad.js — Upload konten ke Meta + buat iklan
import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';

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
      const videoBuffer = fs.readFileSync(file.filepath);
      const videoBlob = new Blob([videoBuffer], { type: file.mimetype });
      const videoForm = new FormData();
      videoForm.append('file', videoBlob, file.originalFilename);

      const videoRes = await fetch(`${META_API}/${accountId}/advideos?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        body: videoForm
      });
      const videoData = await videoRes.json();
      if (videoData.error) {
        const e = videoData.error;
        throw new Error(`Meta: ${e.error_user_msg || e.message} (code: ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})`);
      }

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
              call_to_action: {
                type: ctaMap(cta),
                value: { link: destUrl }
              }
            }
          },
          access_token: token
        })
      });
      const creativeData = await creativeRes.json();
      if (creativeData.error) {
        const e = creativeData.error;
        throw new Error(`Meta creative: ${e.error_user_msg || e.message} (code: ${e.code})`);
      }
      creativeId = creativeData.id;

    } else {
      // ── Upload Gambar ke Meta ──
      const imgBuffer = fs.readFileSync(file.filepath);
      const imgBlob = new Blob([imgBuffer], { type: file.mimetype });
      const imgForm = new FormData();
      imgForm.append(file.originalFilename, imgBlob, file.originalFilename);

      const imgRes = await fetch(`${META_API}/${accountId}/adimages?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        body: imgForm
      });
      const imgData = await imgRes.json();
      if (imgData.error) {
        const e = imgData.error;
        throw new Error(`Meta: ${e.error_user_msg || e.message} (code: ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})`);
      }

      const imageHash = Object.values(imgData.images || {})[0]?.hash;
      if (!imageHash) throw new Error('Gagal upload gambar ke Meta');

      // Create image creative
      const linkData = {
        image_hash: imageHash,
        link: destUrl,
        message: primaryText,
        name: headline,
        call_to_action: {
          type: ctaMap(cta),
          value: { link: destUrl }
        }
      };
      if (description) linkData.description = description;

      const creativeRes = await fetch(`${META_API}/${accountId}/adcreatives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Creative - ${headline}`,
          object_story_spec: {
            page_id: pageId,
            link_data: linkData
          },
          access_token: token
        })
      });
      const creativeData = await creativeRes.json();
      if (creativeData.error) {
        const e = creativeData.error;
        throw new Error(`Meta creative: ${e.error_user_msg || e.message} (code: ${e.code})`);
      }
      creativeId = creativeData.id;
    }

    // Get product info
    const { data: product } = await sb.from('products').select('name').eq('id', productId).single();
    const campaignName = `${product?.name || 'Iklan'} - ${headline}`;

    // Save campaign record — non-critical, don't fail publish if DB write fails
    let campaignId = null;
    try {
      const campaignPayload = {
        user_id: userId,
        name: campaignName,
        ad_account_id: accountId,
        status: 'ACTIVE',
        current_phase: 1,
        autopilot_enabled: true,
      };
      // Add optional columns only if they might exist
      if (productId) campaignPayload.product_id = productId;
      if (creativeId) campaignPayload.meta_creative_id = creativeId;

      const { data: campaign, error: campErr } = await sb.from('campaigns').insert(campaignPayload).select('id').single();
      if (campErr) console.error('campaigns insert error (non-fatal):', campErr.message);
      else campaignId = campaign?.id;
    } catch (e) {
      console.error('campaigns insert failed (non-fatal):', e.message);
    }

    // Save ad copy
    try {
      await sb.from('ad_copies').insert({
        campaign_id: campaignId,
        user_id: userId,
        headline,
        primary_text: primaryText,
        description: description || '',
        status: 'testing'
      });
    } catch (e) {
      console.error('ad_copies insert failed (non-fatal):', e.message);
    }

    // Log
    try {
      await sb.from('action_logs').insert({
        user_id: userId,
        campaign_name: campaignName,
        action_type: 'create',
        description: `Iklan baru berhasil dipublish ke Meta`,
        status: 'success'
      });
    } catch (e) {
      console.error('action_logs insert failed (non-fatal):', e.message);
    }

    // Cleanup temp file
    fs.unlink(file.filepath, () => {});

    return res.status(200).json({ success: true, creative_id: creativeId });
  } catch (err) {
    console.error('create-ad error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function ctaMap(cta) {
  // Accepted Meta CTA enum values — pass through directly
  const metaEnums = ['LEARN_MORE','SHOP_NOW','ORDER_NOW','GET_OFFER','CONTACT_US',
    'SEND_MESSAGE','CALL_NOW','SIGN_UP','SUBSCRIBE','DOWNLOAD','GET_QUOTE',
    'APPLY_NOW','WATCH_MORE','BOOK_NOW'];
  if (metaEnums.includes(cta)) return cta;

  // Legacy display name fallback
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
