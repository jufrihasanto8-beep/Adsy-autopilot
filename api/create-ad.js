// api/create-ad.js — Upload konten ke Meta + buat iklan lengkap (Campaign→AdSet→Creative→Ad)
import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const form = formidable({ maxFileSize: 200 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const file         = files.file?.[0];
    const fileType     = fields.file_type?.[0];
    const headline     = fields.headline?.[0];
    const primaryText  = fields.primary_text?.[0];
    const description  = fields.description?.[0];
    const productId    = fields.product_id?.[0];
    const adAccountDbId= fields.ad_account_db_id?.[0];
    const urlId        = fields.url_id?.[0];
    const cta          = fields.cta?.[0] || 'LEARN_MORE';
    const userId       = fields.user_id?.[0];
    const objective    = fields.objective?.[0] || 'OUTCOME_TRAFFIC';
    const dailyBudget  = parseInt(fields.daily_budget?.[0] || '50000');
    const budgetType   = fields.budget_type?.[0] || 'ABO'; // ABO = ad set budget, CBO = campaign budget
    const bidStrategy  = fields.bid_strategy?.[0] || 'LOWEST_COST_WITHOUT_CAP';
    const bidValue     = fields.bid_value?.[0];
    const campaignNameInput = fields.campaign_name?.[0];
    const startTime    = fields.start_time?.[0];
    const endTime      = fields.end_time?.[0];

    // Reuse existing campaign/adset dari item sebelumnya (multi-file)
    const existingMetaCampaignId = fields.meta_campaign_id?.[0];
    const existingMetaAdsetId    = fields.meta_adset_id?.[0];
    const existingSbCampaignId   = fields.sb_campaign_id?.[0];

    if (!file || !headline || !primaryText) {
      return res.status(400).json({ error: 'File, headline, dan primary text wajib ada' });
    }

    // Get account config
    const { data: accData } = await sb.from('ad_accounts')
      .select('account_id, page_id, pixel_id').eq('id', adAccountDbId).single();
    if (!accData) throw new Error('Ad account tidak ditemukan');

    const { data: urlData } = await sb.from('ad_urls').select('url').eq('id', urlId).single();
    const { data: cfgData } = await sb.from('app_config').select('meta_token').eq('user_id', userId).single();

    const token     = cfgData?.meta_token || process.env.META_ACCESS_TOKEN;
    const accountId = accData.account_id;
    const pageId    = accData.page_id;
    const pixelId   = accData.pixel_id || null;
    const destUrl   = urlData?.url || 'https://wa.me/';

    if (!token) throw new Error('Meta access token belum dikonfigurasi di Pengaturan');

    // ── 1. Upload creative (gambar/video) ──
    let creativeId;

    if (fileType === 'video') {
      const videoBuffer = fs.readFileSync(file.filepath);
      const videoBlob   = new Blob([videoBuffer], { type: file.mimetype });
      const videoForm   = new FormData();
      videoForm.append('file', videoBlob, file.originalFilename);

      const videoRes  = await fetch(`${META_API}/${accountId}/advideos?access_token=${encodeURIComponent(token)}`, { method: 'POST', body: videoForm });
      const videoData = await videoRes.json();
      if (videoData.error) {
        const e = videoData.error;
        throw new Error(`Meta: ${e.error_user_msg || e.message} (code: ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})`);
      }

      const creativeRes  = await fetch(`${META_API}/${accountId}/adcreatives`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Creative - ${headline}`,
          object_story_spec: {
            page_id: pageId,
            video_data: {
              video_id: videoData.id, title: headline, message: primaryText,
              call_to_action: { type: ctaMap(cta), value: { link: destUrl } }
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
      const imgBuffer = fs.readFileSync(file.filepath);
      const imgBlob   = new Blob([imgBuffer], { type: file.mimetype });
      const imgForm   = new FormData();
      imgForm.append(file.originalFilename, imgBlob, file.originalFilename);

      const imgRes  = await fetch(`${META_API}/${accountId}/adimages?access_token=${encodeURIComponent(token)}`, { method: 'POST', body: imgForm });
      const imgData = await imgRes.json();
      if (imgData.error) {
        const e = imgData.error;
        throw new Error(`Meta: ${e.error_user_msg || e.message} (code: ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})`);
      }

      const imageHash = Object.values(imgData.images || {})[0]?.hash;
      if (!imageHash) throw new Error('Gagal upload gambar ke Meta');

      const linkData = {
        image_hash: imageHash, link: destUrl, message: primaryText, name: headline,
        call_to_action: { type: ctaMap(cta), value: { link: destUrl } }
      };
      if (description) linkData.description = description;

      const creativeRes  = await fetch(`${META_API}/${accountId}/adcreatives`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Creative - ${headline}`,
          object_story_spec: { page_id: pageId, link_data: linkData },
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

    // ── 2. Buat Campaign di Meta (hanya jika belum ada) ──
    let metaCampaignId = existingMetaCampaignId;
    let metaAdsetId    = existingMetaAdsetId;
    let sbCampaignId   = existingSbCampaignId || null;

    const { data: product } = await sb.from('products').select('name').eq('id', productId).single();
    const finalCampaignName = campaignNameInput || `${product?.name || 'Iklan'} - ${new Date().toLocaleDateString('id-ID')}`;

    if (!metaCampaignId) {
      const campPayloadMeta = {
        name: finalCampaignName,
        objective,
        status: 'PAUSED',
        special_ad_categories: [],
        access_token: token
      };
      // CBO: budget di campaign level, sharing enabled = false (Meta pakai daily_budget di campaign)
      // ABO: budget di ad set level, jangan set daily_budget di campaign
      if (budgetType === 'CBO') {
        campPayloadMeta.daily_budget = dailyBudget;
        campPayloadMeta.bid_strategy = bidStrategy;
        if (bidValue && bidStrategy !== 'LOWEST_COST_WITHOUT_CAP') {
          if (bidStrategy === 'MINIMUM_ROAS') campPayloadMeta.roas_average_floor = parseFloat(bidValue) * 100;
          else campPayloadMeta.bid_amount = parseInt(bidValue);
        }
      }

      const campRes  = await fetch(`${META_API}/${accountId}/campaigns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(campPayloadMeta)
      });
      const campData = await campRes.json();
      if (campData.error) {
        const e = campData.error;
        throw new Error(`Meta campaign: ${e.error_user_msg || e.message} (code: ${e.code})`);
      }
      metaCampaignId = campData.id;
    }

    // ── 3. Buat Ad Set (hanya jika belum ada) ──
    if (!metaAdsetId) {
      const { optimizationGoal, billingEvent } = objectiveConfig(objective);
      const adsetPayload = {
        name: `${finalCampaignName} - Ad Set`,
        campaign_id: metaCampaignId,
        billing_event: billingEvent,
        optimization_goal: optimizationGoal,
        targeting: {
          geo_locations: { countries: ['ID'] },
          age_min: 18,
          age_max: 65
        },
        status: 'PAUSED',
        access_token: token
      };
      // ABO: budget + bid di ad set level
      if (budgetType === 'ABO') {
        adsetPayload.daily_budget = dailyBudget;
        adsetPayload.bid_strategy = bidStrategy;
        if (bidValue && bidStrategy !== 'LOWEST_COST_WITHOUT_CAP') {
          if (bidStrategy === 'MINIMUM_ROAS') adsetPayload.roas_average_floor = parseFloat(bidValue) * 100;
          else adsetPayload.bid_amount = parseInt(bidValue);
        }
      }

      // promoted_object — wajib untuk beberapa objective
      const promotedObject = getPromotedObject(objective, pageId, pixelId);
      if (promotedObject) adsetPayload.promoted_object = promotedObject;

      if (startTime) adsetPayload.start_time = startTime;
      if (endTime) adsetPayload.end_time = endTime;

      const adsetRes  = await fetch(`${META_API}/${accountId}/adsets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adsetPayload)
      });
      const adsetData = await adsetRes.json();
      if (adsetData.error) {
        const e = adsetData.error;
        throw new Error(`Meta ad set: ${e.error_user_msg || e.message} (code: ${e.code})`);
      }
      metaAdsetId = adsetData.id;
    }

    // ── 4. Buat Ad (hubungkan creative ke ad set) ──
    const adRes  = await fetch(`${META_API}/${accountId}/ads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Ad - ${headline}`,
        adset_id: metaAdsetId,
        creative: { creative_id: creativeId },
        status: 'PAUSED',
        access_token: token
      })
    });
    const adData = await adRes.json();
    if (adData.error) {
      const e = adData.error;
      throw new Error(`Meta ad: ${e.error_user_msg || e.message} (code: ${e.code})`);
    }
    const metaAdId = adData.id;

    // ── 5. Simpan ke Supabase ──
    if (!sbCampaignId) {
      try {
        const campPayload = {
          user_id: userId, name: finalCampaignName,
          ad_account_id: accountId, status: 'PAUSED',
          current_phase: 1, autopilot_enabled: true,
          meta_campaign_id: metaCampaignId,
          meta_adset_id: metaAdsetId,
          daily_budget: dailyBudget
        };
        if (productId) campPayload.product_id = productId;

        const { data: camp, error: campErr } = await sb.from('campaigns').insert(campPayload).select('id').single();
        if (campErr) console.error('campaigns insert error (non-fatal):', campErr.message);
        else sbCampaignId = camp?.id;
      } catch (e) {
        console.error('campaigns insert failed (non-fatal):', e.message);
      }
    }

    try {
      await sb.from('ad_copies').insert({
        campaign_id: sbCampaignId, user_id: userId,
        headline, primary_text: primaryText,
        description: description || '', status: 'testing',
        meta_creative_id: creativeId, meta_ad_id: metaAdId
      });
    } catch (e) { console.error('ad_copies insert failed (non-fatal):', e.message); }

    try {
      await sb.from('action_logs').insert({
        user_id: userId, campaign_name: finalCampaignName,
        action_type: 'create',
        description: `Iklan "${headline}" dipublish ke Meta (Campaign: ${metaCampaignId})`,
        status: 'success'
      });
    } catch (e) { console.error('action_logs insert failed (non-fatal):', e.message); }

    fs.unlink(file.filepath, () => {});

    return res.status(200).json({
      success: true,
      creative_id: creativeId,
      meta_ad_id: metaAdId,
      meta_campaign_id: metaCampaignId,
      meta_adset_id: metaAdsetId,
      campaign_id: sbCampaignId
    });

  } catch (err) {
    console.error('create-ad error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function getPromotedObject(objective, pageId, pixelId) {
  switch (objective) {
    case 'OUTCOME_SALES':
      // Sales butuh pixel + event purchase
      if (pixelId) return { pixel_id: pixelId, custom_event_type: 'PURCHASE' };
      // Fallback ke page jika tidak ada pixel
      if (pageId) return { page_id: pageId };
      return null;
    case 'OUTCOME_LEADS':
      if (pageId) return { page_id: pageId };
      return null;
    case 'OUTCOME_ENGAGEMENT':
      if (pageId) return { page_id: pageId };
      return null;
    case 'OUTCOME_AWARENESS':
      if (pageId) return { page_id: pageId };
      return null;
    case 'OUTCOME_TRAFFIC':
    default:
      return null; // Traffic tidak butuh promoted_object
  }
}

function objectiveConfig(objective) {
  const map = {
    OUTCOME_TRAFFIC:    { optimizationGoal: 'LINK_CLICKS',          billingEvent: 'IMPRESSIONS' },
    OUTCOME_LEADS:      { optimizationGoal: 'LEAD_GENERATION',      billingEvent: 'IMPRESSIONS' },
    OUTCOME_SALES:      { optimizationGoal: 'OFFSITE_CONVERSIONS',  billingEvent: 'IMPRESSIONS' },
    OUTCOME_ENGAGEMENT: { optimizationGoal: 'POST_ENGAGEMENT',      billingEvent: 'IMPRESSIONS' },
    OUTCOME_AWARENESS:  { optimizationGoal: 'REACH',                billingEvent: 'IMPRESSIONS' },
  };
  return map[objective] || map.OUTCOME_TRAFFIC;
}

function ctaMap(cta) {
  const metaEnums = ['LEARN_MORE','SHOP_NOW','ORDER_NOW','GET_OFFER','CONTACT_US',
    'SEND_MESSAGE','CALL_NOW','SIGN_UP','SUBSCRIBE','DOWNLOAD','GET_QUOTE',
    'APPLY_NOW','WATCH_MORE','BOOK_NOW'];
  if (metaEnums.includes(cta)) return cta;
  const map = {
    'Hubungi Sekarang': 'CONTACT_US', 'Pesan Sekarang': 'ORDER_NOW',
    'Ambil Promo': 'GET_OFFER', 'Beli Sekarang': 'SHOP_NOW',
    'Daftar Gratis': 'SIGN_UP', 'Pelajari Lebih': 'LEARN_MORE'
  };
  return map[cta] || 'LEARN_MORE';
}
