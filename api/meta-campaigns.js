// api/meta-campaigns.js — Buat, sync, toggle, hapus kampanye Meta
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return await syncCampaigns(req, res);
    if (req.method === 'POST' && req.body?.action === 'duplicate') return await duplicateCampaign(req, res);
    if (req.method === 'POST') return await createCampaign(req, res);
    if (req.method === 'PATCH') {
      if (req.body.action === 'update_budget') return await updateBudget(req, res);
      return await toggleStatus(req, res);
    }
    if (req.method === 'DELETE') return await deleteCampaign(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('meta-campaigns error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── GET: Sync kampanye dari Meta ke Supabase ──
async function syncCampaigns(req, res) {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id required' });

  const { data: config } = await sb.from('app_config').select('meta_token').eq('user_id', userId).single();
  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(400).json({ error: 'Token Meta belum dikonfigurasi' });

  // Ambil semua ad accounts user
  const { data: adAccounts } = await sb.from('ad_accounts').select('account_id').eq('user_id', userId);
  if (!adAccounts?.length) return res.status(200).json({ synced: 0, message: 'Tidak ada ad account' });

  let synced = 0;
  let deleted = 0;

  for (const acc of adAccounts) {
    try {
      // Ambil semua kampanye dari Meta termasuk yang DELETED
      const fields = 'id,name,status,objective,daily_budget,created_time';
      const metaRes = await fetch(
        `${META_API}/${acc.account_id}/campaigns?fields=${fields}&effective_status=["ACTIVE","PAUSED","ARCHIVED","DELETED"]&limit=500&access_token=${encodeURIComponent(token)}`
      );
      const metaData = await metaRes.json();
      if (metaData.error || !metaData.data) continue;

      // Kumpulkan semua meta_campaign_id yang masih ada di Meta
      const metaIds = new Set(metaData.data.map(c => c.id));

      for (const camp of metaData.data) {
        const isDeleted = camp.status === 'DELETED' || camp.status === 'ARCHIVED';

        const { data: existing } = await sb.from('campaigns')
          .select('id').eq('meta_campaign_id', camp.id).single();

        if (existing) {
          if (isDeleted) {
            // Kampanye dihapus/diarsip di Meta → hapus dari Supabase
            await sb.from('ad_copies').delete().eq('campaign_id', existing.id);
            await sb.from('campaigns').delete().eq('id', existing.id);
            deleted++;
          } else {
            // Update status & nama
            await sb.from('campaigns').update({
              status: camp.status,
              name: camp.name
            }).eq('meta_campaign_id', camp.id);
            synced++;
          }
        } else if (!isDeleted) {
          // Kampanye baru di Meta yang belum ada di Supabase
          await sb.from('campaigns').insert({
            user_id: userId,
            meta_campaign_id: camp.id,
            name: camp.name,
            status: camp.status,
            ad_account_id: acc.account_id,
            daily_budget: camp.daily_budget ? parseInt(camp.daily_budget) : 0,
            current_phase: 1,
            autopilot_enabled: false
          });
          synced++;
        }
      }

      // Hapus kampanye di Supabase yang tidak ada lagi di Meta
      // (sudah dihapus permanen, tidak muncul sama sekali di response)
      const { data: sbCamps } = await sb.from('campaigns')
        .select('id, meta_campaign_id')
        .eq('user_id', userId)
        .eq('ad_account_id', acc.account_id)
        .not('meta_campaign_id', 'is', null);

      for (const sbCamp of (sbCamps || [])) {
        if (sbCamp.meta_campaign_id && !metaIds.has(sbCamp.meta_campaign_id)) {
          await sb.from('ad_copies').delete().eq('campaign_id', sbCamp.id);
          await sb.from('campaigns').delete().eq('id', sbCamp.id);
          deleted++;
        }
      }

    } catch (e) {
      console.error('sync error for', acc.account_id, e.message);
    }
  }

  return res.status(200).json({ success: true, synced, deleted });
}

// ── PATCH: Toggle status kampanye (ACTIVE/PAUSED) ──
async function toggleStatus(req, res) {
  const { id, meta_campaign_id, status, user_id } = req.body;

  const { data: config } = await sb.from('app_config').select('meta_token').eq('user_id', user_id).single();
  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('Token Meta belum dikonfigurasi');

  // Update di Meta
  if (meta_campaign_id && meta_campaign_id !== 'null') {
    const metaRes = await fetch(`${META_API}/${meta_campaign_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, access_token: token })
    });
    const metaData = await metaRes.json();
    if (metaData.error) {
      const e = metaData.error;
      throw new Error(`Meta: ${e.error_user_msg || e.message} (code: ${e.code})`);
    }
  }

  // Update di Supabase
  await sb.from('campaigns').update({ status }).eq('id', id);

  return res.status(200).json({ success: true, status });
}

// ── PATCH action=update_budget: Update budget kampanye ──
async function updateBudget(req, res) {
  const { id, meta_campaign_id, meta_adset_id, daily_budget, user_id } = req.body;
  if (!daily_budget || daily_budget < 1000) throw new Error('Budget minimal Rp 1.000');

  const { data: config } = await sb.from('app_config').select('meta_token').eq('user_id', user_id).single();
  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('Token Meta belum dikonfigurasi');

  // CBO (Phase 1, 2a): budget di campaign level
  // ABO (Phase 2b): budget di adset level
  const targetId = (req.body.phase_type === '2b' && meta_adset_id) ? meta_adset_id : meta_campaign_id;
  if (targetId && targetId !== 'null') {
    const metaRes = await fetch(`${META_API}/${targetId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_budget: String(Math.round(daily_budget)), access_token: token })
    });
    const metaData = await metaRes.json();
    if (metaData.error) {
      const e = metaData.error;
      throw new Error(`Meta: ${e.error_user_msg || e.message} (code: ${e.code})`);
    }
  }

  // Update di Supabase
  await sb.from('campaigns').update({ daily_budget, initial_budget: daily_budget }).eq('id', id);

  return res.status(200).json({ success: true, daily_budget });
}

// ── DELETE: Hapus kampanye dari Meta + Supabase ──
async function deleteCampaign(req, res) {
  const { id, meta_campaign_id, user_id } = req.body;

  const { data: config } = await sb.from('app_config').select('meta_token').eq('user_id', user_id).single();
  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('Token Meta belum dikonfigurasi');

  // Hapus dari Meta
  if (meta_campaign_id && meta_campaign_id !== 'null') {
    const metaRes = await fetch(`${META_API}/${meta_campaign_id}?access_token=${encodeURIComponent(token)}`, {
      method: 'DELETE'
    });
    const metaData = await metaRes.json();
    if (metaData.error) {
      const e = metaData.error;
      // Log tapi jangan block — tetap hapus dari Supabase
      console.error(`Meta delete error: ${e.error_user_msg || e.message}`);
    }
  }

  // Hapus semua rows Supabase dengan meta_campaign_id yg sama
  // (cover Phase 2b groups: multiple adsets share 1 meta_campaign_id)
  if (meta_campaign_id && meta_campaign_id !== 'null') {
    const { data: siblings } = await sb.from('campaigns')
      .select('id').eq('meta_campaign_id', meta_campaign_id);
    for (const row of (siblings || [])) {
      await sb.from('ad_copies').delete().eq('campaign_id', row.id);
    }
    await sb.from('campaigns').delete().eq('meta_campaign_id', meta_campaign_id);
  } else {
    await sb.from('ad_copies').delete().eq('campaign_id', id);
    await sb.from('campaigns').delete().eq('id', id);
  }

  // Log
  try {
    await sb.from('action_logs').insert({
      user_id,
      action_type: 'delete',
      description: `Kampanye dihapus (Meta ID: ${meta_campaign_id})`,
      status: 'success'
    });
  } catch (e) { /* non-fatal */ }

  return res.status(200).json({ success: true });
}

// ── POST: Buat kampanye baru ──
async function createCampaign(req, res) {
  const {
    name, objective, daily_budget, age_range, gender,
    content_id, ad_account_id, page_id, autopilot_enabled, user_id
  } = req.body;

  const { data: config } = await sb.from('app_config')
    .select('meta_token').eq('user_id', user_id).single();

  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('Meta access token belum dikonfigurasi');

  const accountId = ad_account_id;

  const campRes = await fetch(`${META_API}/${accountId}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      objective: objective || 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: [],
      access_token: token
    })
  });
  const campData = await campRes.json();
  if (campData.error) throw new Error(campData.error.message);

  const [ageMin, ageMax] = (age_range || '18-65').split('-').map(Number);
  const adSetRes = await fetch(`${META_API}/${accountId}/adsets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${name} - Ad Set`,
      campaign_id: campData.id,
      daily_budget: daily_budget || 50000,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: {
        age_min: ageMin || 18,
        age_max: ageMax || 65,
        genders: gender === 'MALE' ? [1] : gender === 'FEMALE' ? [2] : [],
        geo_locations: { countries: ['ID'] }
      },
      status: 'PAUSED',
      access_token: token
    })
  });
  const adSetData = await adSetRes.json();
  if (adSetData.error) throw new Error(adSetData.error.message);

  const { data: campaign, error: dbError } = await sb.from('campaigns').insert({
    user_id,
    meta_campaign_id: campData.id,
    meta_adset_id: adSetData.id,
    name,
    ad_account_id: accountId,
    daily_budget: daily_budget || 50000,
    status: 'PAUSED',
    current_phase: 1,
    autopilot_enabled: autopilot_enabled !== false
  }).select().single();

  if (dbError) throw dbError;

  await sb.from('action_logs').insert({
    user_id, campaign_name: name, action_type: 'create',
    description: `Kampanye "${name}" berhasil dibuat`, status: 'success'
  });

  return res.status(200).json({ success: true, campaign });
}

// ── POST action=duplicate: Duplikat kampanye winner dengan creative baru ──
async function duplicateCampaign(req, res) {
  const { id, new_name, content_library_id, user_id } = req.body;
  if (!id || !new_name || !content_library_id || !user_id) throw new Error('Data tidak lengkap');

  const { data: orig } = await sb.from('campaigns').select('*').eq('id', id).single();
  if (!orig) throw new Error('Kampanye tidak ditemukan');

  const { data: config } = await sb.from('app_config').select('meta_token').eq('user_id', user_id).single();
  const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('Token Meta belum dikonfigurasi');

  // Ambil meta_creative_id dari konten yang dipilih
  const { data: adCopy } = await sb.from('ad_copies')
    .select('meta_creative_id, file_name').eq('content_library_id', content_library_id)
    .not('meta_creative_id', 'is', null).limit(1).maybeSingle();
  if (!adCopy?.meta_creative_id) throw new Error('Konten ini belum pernah dipakai dalam iklan. Upload dulu via Buat Iklan.');

  // Ambil detail kampanye asli dari Meta
  const campInfo = await fetch(`${META_API}/${orig.meta_campaign_id}?fields=account_id,objective,special_ad_categories&access_token=${encodeURIComponent(token)}`).then(r => r.json());
  if (campInfo.error) throw new Error('Gagal ambil data Meta: ' + campInfo.error.message);
  const accountId = campInfo.account_id;

  // Ambil targeting dari adset asli
  let targeting = { age_min: 21, geo_locations: { countries: ['ID'] }, targeting_automation: { advantage_audience: 0 } };
  let optimizationGoal = 'OFFSITE_CONVERSIONS', billingEvent = 'IMPRESSIONS', promotedObject = null;
  if (orig.meta_adset_id) {
    const adsetInfo = await fetch(`${META_API}/${orig.meta_adset_id}?fields=targeting,optimization_goal,billing_event,promoted_object&access_token=${encodeURIComponent(token)}`).then(r => r.json());
    if (!adsetInfo.error && adsetInfo.targeting) {
      const t = { ...adsetInfo.targeting };
      ['age_min','age_max','brand_safety_content_filter_levels','targeting_automation'].forEach(k => delete t[k]);
      t.age_min = 21;
      t.targeting_automation = { advantage_audience: 0 };
      targeting = t;
      optimizationGoal = adsetInfo.optimization_goal || optimizationGoal;
      billingEvent = adsetInfo.billing_event || billingEvent;
      if (adsetInfo.promoted_object) promotedObject = adsetInfo.promoted_object;
    }
  }

  // Buat campaign baru di Meta (PAUSED, CBO)
  const newCamp = await fetch(`${META_API}/act_${accountId}/campaigns`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: new_name, objective: campInfo.objective, status: 'PAUSED', special_ad_categories: [], daily_budget: String(Math.round(orig.daily_budget || 50000)), is_adset_budget_sharing_enabled: true, access_token: token })
  }).then(r => r.json());
  if (newCamp.error) throw new Error('Gagal buat kampanye: ' + (newCamp.error.error_user_msg || newCamp.error.message));

  // Buat adset baru
  const newAdset = await fetch(`${META_API}/act_${accountId}/adsets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: new_name, campaign_id: newCamp.id, optimization_goal: optimizationGoal, billing_event: billingEvent, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', status: 'PAUSED', targeting, ...(promotedObject ? { promoted_object: promotedObject } : {}), access_token: token })
  }).then(r => r.json());
  if (newAdset.error) throw new Error('Gagal buat adset: ' + (newAdset.error.error_user_msg || newAdset.error.message));

  // Buat ad dengan creative baru
  const newAd = await fetch(`${META_API}/act_${accountId}/ads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: new_name, adset_id: newAdset.id, creative: { creative_id: adCopy.meta_creative_id }, status: 'PAUSED', access_token: token })
  }).then(r => r.json());
  if (newAd.error) throw new Error('Gagal buat ad: ' + (newAd.error.error_user_msg || newAd.error.message));

  // Simpan ke Supabase
  const { data: saved } = await sb.from('campaigns').insert({
    user_id, name: new_name, status: 'PAUSED',
    meta_campaign_id: newCamp.id, meta_adset_id: newAdset.id,
    daily_budget: orig.daily_budget, current_phase: 1,
    ad_account_id: orig.ad_account_id, product_id: orig.product_id,
    autopilot_enabled: false, objective: orig.objective,
    campaign_type: orig.campaign_type || 'standard'
  }).select().single();

  await sb.from('ad_copies').insert({
    campaign_id: saved.id, user_id, content_library_id,
    meta_creative_id: adCopy.meta_creative_id, meta_ad_id: newAd.id, file_name: adCopy.file_name
  });

  await sb.from('action_logs').insert({ user_id, campaign_name: new_name, action_type: 'duplicate', description: `Duplikat dari "${orig.name}"`, status: 'success' });

  return res.status(200).json({ success: true, campaign: saved });
}
