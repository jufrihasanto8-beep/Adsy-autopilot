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
    const adStatus     = fields.auto_activate?.[0] === '1' ? 'ACTIVE' : 'PAUSED';

    // Reuse existing campaign/adset dari item sebelumnya (multi-file)
    const existingMetaCampaignId = fields.meta_campaign_id?.[0];
    const existingMetaAdsetId    = fields.meta_adset_id?.[0];
    const existingSbCampaignId   = fields.sb_campaign_id?.[0];

    const preUploadedVideoId = fields.video_id?.[0]; // Video sudah diupload dari browser langsung ke Meta
    const thumbnailImageHash = fields.thumbnail_image_hash?.[0]; // Thumbnail di-extract & upload dari browser

    if (!file && !preUploadedVideoId) {
      return res.status(400).json({ error: 'File atau video_id wajib ada' });
    }
    if (!headline || !primaryText) {
      return res.status(400).json({ error: 'Headline dan primary text wajib ada' });
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
      let metaVideoId;

      if (preUploadedVideoId) {
        // Video sudah diupload langsung dari browser ke Meta — skip upload
        metaVideoId = preUploadedVideoId;
      } else {
        // Upload melalui server (fallback untuk file kecil)
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
        metaVideoId = videoData.id;
      }

      // Deklarasi payload dulu
      const videoDataPayload = {
        video_id: metaVideoId,
        title: headline,
        message: primaryText,
        call_to_action: { type: ctaMap(cta), value: { link: destUrl } }
      };

      // Thumbnail: pakai image_hash dari browser (paling cepat, no-wait)
      // Fallback: fetch dari Meta dengan retry kalau hash tidak tersedia
      if (thumbnailImageHash) {
        videoDataPayload.image_hash = thumbnailImageHash;
      } else {
        let thumbnailUrl = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            if (attempt > 0) await new Promise(r => setTimeout(r, 5000));
            const thumbRes  = await fetch(`${META_API}/${metaVideoId}?fields=picture,thumbnails&access_token=${encodeURIComponent(token)}`);
            const thumbData = await thumbRes.json();
            thumbnailUrl = thumbData?.picture || null;
            if (!thumbnailUrl) {
              const thumbs = thumbData?.thumbnails?.data || [];
              const midIdx = Math.floor(thumbs.length / 2);
              thumbnailUrl = thumbs[midIdx]?.uri || thumbs[0]?.uri || null;
            }
            if (thumbnailUrl) break;
          } catch (e) {
            console.warn(`Thumbnail attempt ${attempt + 1} gagal:`, e.message);
          }
        }
        if (!thumbnailUrl) {
          throw new Error('Thumbnail video belum siap di Meta. Coba beberapa detik lagi lalu publish ulang.');
        }
        videoDataPayload.image_url = thumbnailUrl;
      }

      const creativeRes  = await fetch(`${META_API}/${accountId}/adcreatives`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Creative - ${headline}`,
          object_story_spec: {
            page_id: pageId,
            video_data: videoDataPayload
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

    const { data: product } = await sb.from('products').select('name, target_cpr').eq('id', productId).single();
    const finalCampaignName = campaignNameInput || `${product?.name || 'Iklan'} - ${new Date().toLocaleDateString('id-ID')}`;

    if (!metaCampaignId) {
      const campPayloadMeta = {
        name: finalCampaignName,
        objective,
        status: adStatus,
        special_ad_categories: [],
        access_token: token
      };
      // CBO: budget di campaign level + sharing enabled
      // ABO: budget di ad set level, is_adset_budget_sharing_enabled wajib = false
      if (budgetType === 'CBO') {
        campPayloadMeta.daily_budget = dailyBudget;
        campPayloadMeta.bid_strategy = bidStrategy;
        if (bidValue && bidStrategy !== 'LOWEST_COST_WITHOUT_CAP') {
          if (bidStrategy === 'MINIMUM_ROAS') campPayloadMeta.roas_average_floor = parseFloat(bidValue) * 100;
          else campPayloadMeta.bid_amount = parseInt(bidValue);
        }
      } else {
        // ABO — Meta wajib tahu bahwa budget tidak di-share di campaign level
        campPayloadMeta.is_adset_budget_sharing_enabled = false;
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
      // Baca global settings (lokasi & penempatan dari admin)
      const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
      const { data: globalCfg } = await sb.from('global_settings').select('*').eq('id', SETTINGS_ID).single();

      // Bangun geo targeting dari pilihan provinsi admin
      const locMode = globalCfg?.ad_location_mode || 'include';
      const selectedProvinces = globalCfg?.ad_selected_provinces || [];
      let geoLocations = { countries: ['ID'] };
      let excludedGeoLocations = null;

      if (selectedProvinces.length > 0) {
        // Fetch region key dari Meta untuk setiap provinsi
        const regionKeys = await resolveProvinceKeys(selectedProvinces, token);
        if (regionKeys.length > 0) {
          if (locMode === 'exclude') {
            excludedGeoLocations = { regions: regionKeys };
          } else {
            geoLocations = { regions: regionKeys };
          }
        }
      }

      const { optimizationGoal, billingEvent } = objectiveConfig(objective);
      const adsetPayload = {
        name: `${finalCampaignName} - Ad Set`,
        campaign_id: metaCampaignId,
        billing_event: billingEvent,
        optimization_goal: optimizationGoal,
        targeting: {
          geo_locations: geoLocations,
          ...(excludedGeoLocations ? { excluded_geo_locations: excludedGeoLocations } : {}),
          age_min: 21,
          age_max: 65
        },
        status: adStatus,
        access_token: token
      };

      // Terapkan placement jika admin set manual
      const plMode = globalCfg?.ad_placement_mode || 'AUTO';
      if (plMode === 'MANUAL' && globalCfg?.ad_manual_placements?.length) {
        const pl = globalCfg.ad_manual_placements;
        const publisherPlatforms = [];
        const fbPositions = [];
        const igPositions = [];
        const msgPositions = [];
        const anPositions = [];

        // Platform dari plt_* checkboxes (prioritas), fallback ke deteksi dari posisi
        if (pl.includes('plt_facebook') || pl.some(p => p.startsWith('fb_'))) publisherPlatforms.push('facebook');
        if (pl.includes('plt_instagram') || pl.some(p => p.startsWith('ig_'))) publisherPlatforms.push('instagram');
        if (pl.includes('plt_messenger') || pl.some(p => p.startsWith('msg_'))) publisherPlatforms.push('messenger');
        if (pl.includes('plt_audience_network') || pl.some(p => p.startsWith('an_'))) publisherPlatforms.push('audience_network');
        if (pl.includes('plt_threads')) publisherPlatforms.push('threads');

        if (pl.includes('fb_feed'))        fbPositions.push('feed');
        if (pl.includes('fb_story'))       fbPositions.push('story');
        if (pl.includes('fb_marketplace')) fbPositions.push('marketplace');
        if (pl.includes('fb_search'))      fbPositions.push('search');
        // fb_video_feeds dihapus — sudah tidak didukung Meta API v18+
        if (pl.includes('ig_stream'))      igPositions.push('stream');
        if (pl.includes('ig_story'))       igPositions.push('story');
        if (pl.includes('ig_reels'))       igPositions.push('reels');
        if (pl.includes('ig_explore'))     igPositions.push('explore');
        if (pl.includes('msg_home'))       msgPositions.push('messenger_home');
        if (pl.includes('msg_story'))      msgPositions.push('story');
        if (pl.includes('an_classic'))     anPositions.push('classic');
        if (pl.includes('an_video'))       anPositions.push('instream_video');

        // Hanya tambah platform kalau ada posisi yang dipilih
        const finalPlatforms = [];
        if (fbPositions.length)  { finalPlatforms.push('facebook');  adsetPayload.targeting.facebook_positions = fbPositions; }
        if (igPositions.length)  { finalPlatforms.push('instagram'); adsetPayload.targeting.instagram_positions = igPositions; }
        if (msgPositions.length) { finalPlatforms.push('messenger'); adsetPayload.targeting.messenger_positions = msgPositions; }
        if (anPositions.length)  { finalPlatforms.push('audience_network'); adsetPayload.targeting.audience_network_positions = anPositions; }
        if (pl.includes('plt_threads') && finalPlatforms.length) finalPlatforms.push('threads');
        if (finalPlatforms.length) adsetPayload.targeting.publisher_platforms = finalPlatforms;
      }
      // Jika AUTO: tidak set publisher_platforms → Meta pakai Advantage+ Placement
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
        status: adStatus,
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
          ad_account_id: accountId, status: adStatus,
          current_phase: 1, autopilot_enabled: true,
          meta_campaign_id: metaCampaignId,
          meta_adset_id: metaAdsetId,
          daily_budget: dailyBudget
        };
        if (productId) campPayload.product_id = productId;
        if (product?.target_cpr) campPayload.target_cpr = product.target_cpr;

        const { data: camp, error: campErr } = await sb.from('campaigns').insert(campPayload).select('id').single();
        if (campErr) console.error('campaigns insert error (non-fatal):', campErr.message);
        else sbCampaignId = camp?.id;
      } catch (e) {
        console.error('campaigns insert failed (non-fatal):', e.message);
      }
    }

    // ── Upsert ke content_library ── track file ini untuk performa
    let contentLibraryId = null;
    try {
      const fileName = file?.originalFilename || file?.newFilename || `content-${Date.now()}`;
      const { data: existingContent } = await sb.from('content_library')
        .select('id').eq('user_id', userId).eq('name', fileName).single();
      if (existingContent) {
        contentLibraryId = existingContent.id;
        await sb.from('content_library').update({ status: 'used' }).eq('id', contentLibraryId);
      } else {
        const { data: newContent } = await sb.from('content_library').insert({
          user_id: userId,
          name: fileName,
          content_type: fileType || 'image',
          status: 'used',
          gdrive_url: null
        }).select('id').single();
        contentLibraryId = newContent?.id;
      }
    } catch (e) { console.error('content_library upsert failed (non-fatal):', e.message); }

    try {
      await sb.from('ad_copies').insert({
        campaign_id: sbCampaignId, user_id: userId,
        headline, primary_text: primaryText,
        description: description || '', status: 'testing',
        meta_creative_id: creativeId, meta_ad_id: metaAdId,
        file_name: file?.originalFilename || file?.newFilename || null,
        content_library_id: contentLibraryId || null
      });
    } catch (e) { console.error('ad_copies insert failed (non-fatal):', e.message); }

    try {
      await sb.from('action_logs').insert({
        user_id: userId, campaign_name: finalCampaignName,
        action_type: 'create',
        description: `Iklan "${headline}" berhasil dipublish`,
        status: 'success'
      });
    } catch (e) { console.error('action_logs insert failed (non-fatal):', e.message); }

    // Kirim WA notif hanya saat file pertama (campaign baru dibuat), bukan file ke-2 dst
    if (!existingMetaCampaignId) {
      sendWANotif(userId, finalCampaignName, headline, adStatus).catch(() => {});
    }

    if (file?.filepath) fs.unlink(file.filepath, () => {});

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

async function sendWANotif(userId, campaignName, headline, status) {
  try {
    // Ambil fonnte token dari admin (siapapun yang punya fonnte_token)
    let fonnteToken = process.env.FONNTE_TOKEN;
    if (!fonnteToken) {
      const { data: adminCfg } = await sb.from('app_config')
        .select('fonnte_token').not('fonnte_token', 'is', null).limit(1).single();
      fonnteToken = adminCfg?.fonnte_token;
    }
    if (!fonnteToken) return;

    // Ambil wa_target + notif_create preference user
    const [{ data: cfg }, { data: notif }] = await Promise.all([
      sb.from('app_config').select('wa_target').eq('user_id', userId).single(),
      sb.from('notif_settings').select('notif_create').eq('user_id', userId).maybeSingle()
    ]);

    if (!cfg?.wa_target) return;
    if (notif?.notif_create === false) return; // user matikan notif create

    const now = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
    const statusLabel = status === 'ACTIVE' ? '🟢 Langsung aktif' : '⏸️ Status Paused';

    const message = `🚀 *Iklan Baru Dipublish!*\n📅 ${now} WIB\n\n*Kampanye:* ${campaignName}\n*Iklan:* ${headline}\n*Status:* ${statusLabel}\n\n_Cek dashboard untuk detail_`;

    await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': fonnteToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: cfg.wa_target, message })
    });
  } catch (err) {
    console.error('sendWANotif error:', err.message);
  }
}

// Mapping nama provinsi Indonesia → query yang cocok di Meta
const PROVINCE_SEARCH = {
  'NTB':            'Nusa Tenggara Barat',
  'NTT':            'Nusa Tenggara Timur',
  'DKI Jakarta':    'Jakarta',
  'DI Yogyakarta':  'Yogyakarta',
  'Papua Barat':    'West Papua',
  'Papua':          'Papua',
  'Maluku Utara':   'North Maluku',
  'Sulawesi Utara': 'North Sulawesi',
  'Sulawesi Tengah':'Central Sulawesi',
  'Sulawesi Selatan':'South Sulawesi',
  'Sulawesi Tenggara':'Southeast Sulawesi',
  'Sulawesi Barat': 'West Sulawesi',
  'Kalimantan Barat':'West Kalimantan',
  'Kalimantan Tengah':'Central Kalimantan',
  'Kalimantan Selatan':'South Kalimantan',
  'Kalimantan Timur':'East Kalimantan',
  'Kalimantan Utara':'North Kalimantan',
  'Sumatera Utara': 'North Sumatra',
  'Sumatera Barat': 'West Sumatra',
  'Sumatera Selatan':'South Sumatra',
  'Jawa Barat':     'West Java',
  'Jawa Tengah':    'Central Java',
  'Jawa Timur':     'East Java',
};

// Fetch region key dari Meta API per nama provinsi (parallel)
async function resolveProvinceKeys(provinceNames, token) {
  const results = await Promise.all(provinceNames.map(async (name) => {
    try {
      const query = PROVINCE_SEARCH[name] || name;
      const url = `${META_API}/search?type=adgeolocation&q=${encodeURIComponent(query)}&location_types[0]=region&country_codes[0]=ID&access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url);
      const data = await res.json();
      const match = data.data?.find(r => r.type === 'region' && r.country_code === 'ID');
      return match ? { key: match.key } : null;
    } catch (e) {
      console.warn('resolveProvinceKeys error for', name, e.message);
      return null;
    }
  }));
  return results.filter(Boolean);
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
