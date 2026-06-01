// api/meta-insights.js — Sync performa dari Meta Ads
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const META_API = 'https://graph.facebook.com/v18.0';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Get all active campaigns
    const { data: campaigns } = await sb.from('campaigns')
      .select('*, profiles(id)')
      .eq('status', 'ACTIVE')
      .not('meta_campaign_id', 'is', null);

    if (!campaigns || campaigns.length === 0) {
      return res.status(200).json({ synced: 0 });
    }

    let synced = 0;

    for (const camp of campaigns) {
      try {
        // Get user token
        const { data: config } = await sb.from('app_config')
          .select('meta_token').eq('user_id', camp.user_id).single();

        const token = config?.meta_token || process.env.META_ACCESS_TOKEN;
        if (!token) continue;

        // Fetch insights from Meta
        const fields = 'spend,clicks,impressions,ctr,cpc,actions,cost_per_action_type';
        const insightRes = await fetch(
          `${META_API}/${camp.meta_campaign_id}/insights?fields=${fields}&date_preset=today&access_token=${token}`
        );
        const insight = await insightRes.json();

        if (insight.error || !insight.data || insight.data.length === 0) continue;

        const d = insight.data[0];
        const results = d.actions?.find(a => a.action_type === 'link_click')?.value || 0;
        const cpr = results > 0 ? parseFloat(d.spend) / results : null;

        // Update campaign
        await sb.from('campaigns').update({
          spend_today: parseFloat(d.spend) * 1000, // convert to IDR approx
          clicks_today: parseInt(d.clicks) || 0,
          ctr: parseFloat(d.ctr) || null,
          cpr: cpr ? cpr * 1000 : null,
          results_today: parseInt(results),
          last_synced: new Date().toISOString()
        }).eq('id', camp.id);

        synced++;
      } catch (e) {
        console.error(`Error syncing campaign ${camp.id}:`, e.message);
      }
    }

    return res.status(200).json({ success: true, synced });
  } catch (err) {
    console.error('meta-insights error:', err);
    return res.status(500).json({ error: err.message });
  }
}
