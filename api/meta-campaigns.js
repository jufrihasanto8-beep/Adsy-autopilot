// api/meta-campaigns.js — Buat & kelola Meta campaign
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      name, objective, daily_budget, age_range, gender,
      content_id, ad_account_id, page_id, autopilot_enabled, user_id
    } = req.body;

    // Get user config (token)
    const { data: config } = await sb.from('app_config')
      .select('meta_token, meta_account, meta_page').eq('user_id', user_id).single();

    const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
    const accountId = ad_account_id || config?.meta_account;
    const fbPageId = page_id || config?.meta_page;

    if (!token) throw new Error('Meta access token belum dikonfigurasi');

    // Get content from library
    const { data: content } = await sb.from('content_library')
      .select('*').eq('id', content_id).single();

    if (!content) throw new Error('Konten tidak ditemukan di library');

    // 1. Create Campaign
    const campRes = await fetch(`${META_API}/${accountId}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        objective: objective || 'OUTCOME_TRAFFIC',
        status: 'ACTIVE',
        special_ad_categories: [],
        access_token: token
      })
    });
    const campData = await campRes.json();
    if (campData.error) throw new Error(campData.error.message);

    // 2. Create Ad Set
    const [ageMin, ageMax] = (age_range || '18-45').split('-').map(Number);
    const adSetRes = await fetch(`${META_API}/${accountId}/adsets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${name} - Ad Set 1`,
        campaign_id: campData.id,
        daily_budget: (daily_budget || 50000) * 100, // Meta uses cents
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        targeting: {
          age_min: ageMin || 18,
          age_max: ageMax || 45,
          genders: gender === 'MALE' ? [1] : gender === 'FEMALE' ? [2] : [],
          geo_locations: { countries: ['ID'] }
        },
        status: 'ACTIVE',
        access_token: token
      })
    });
    const adSetData = await adSetRes.json();
    if (adSetData.error) throw new Error(adSetData.error.message);

    // 3. Save to Supabase
    const { data: campaign, error: dbError } = await sb.from('campaigns').insert({
      user_id,
      meta_campaign_id: campData.id,
      meta_adset_id: adSetData.id,
      name,
      objective,
      daily_budget: daily_budget || 50000,
      content_id,
      ad_account_id: accountId,
      page_id: fbPageId,
      status: 'ACTIVE',
      current_phase: 1,
      autopilot_enabled: autopilot_enabled !== false
    }).select().single();

    if (dbError) throw dbError;

    // Log action
    await sb.from('action_logs').insert({
      user_id,
      campaign_id: campaign.id,
      campaign_name: name,
      action_type: 'create',
      description: `Kampanye "${name}" berhasil dibuat`,
      status: 'success'
    });

    return res.status(200).json({ success: true, campaign });
  } catch (err) {
    console.error('meta-campaigns error:', err);
    return res.status(500).json({ error: err.message });
  }
}
