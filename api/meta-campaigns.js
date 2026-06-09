// api/meta-campaigns.js — Buat, sync, toggle, hapus kampanye Meta
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return await syncCampaigns(req, res);
    if (req.method === 'POST') return await createCampaign(req, res);
    if (req.method === 'PATCH') return await toggleStatus(req, res);
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

  // Hapus ad_copies terkait
  await sb.from('ad_copies').delete().eq('campaign_id', id);

  // Hapus dari Supabase
  await sb.from('campaigns').delete().eq('id', id);

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
