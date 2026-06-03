-- ============================================
-- ADSY AUTOPILOT — Supabase Schema
-- Jalankan di Supabase SQL Editor
-- ============================================

-- 1. PROFILES (user data + role)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT,
  role TEXT DEFAULT 'advertiser' CHECK (role IN ('admin', 'advertiser', 'viewer', 'superadmin')),
  wa_number TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, name)
  VALUES (NEW.id, NEW.email, SPLIT_PART(NEW.email, '@', 1));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- 2. APP CONFIG (API keys per user)
CREATE TABLE app_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  meta_token TEXT,
  meta_account TEXT,
  meta_page TEXT,
  fonnte_token TEXT,
  wa_target TEXT,
  claude_key TEXT,
  claude_model TEXT DEFAULT 'claude-sonnet-4-6',
  gdrive_sa TEXT,
  gdrive_public BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. CONTENT LIBRARY
CREATE TABLE content_library (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  gdrive_url TEXT NOT NULL,
  gdrive_file_id TEXT,
  thumb_url TEXT,
  content_type TEXT DEFAULT 'image' CHECK (content_type IN ('image', 'video')),
  category TEXT,
  audience TEXT,
  notes TEXT,
  status TEXT DEFAULT 'ready' CHECK (status IN ('ready', 'used', 'archived')),
  times_used INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. CAMPAIGNS
CREATE TABLE campaigns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content_library(id),
  meta_campaign_id TEXT,
  meta_adset_id TEXT,
  meta_ad_id TEXT,
  name TEXT NOT NULL,
  objective TEXT,
  daily_budget NUMERIC DEFAULT 50000,
  ad_account_id TEXT,
  page_id TEXT,
  status TEXT DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  current_phase INT DEFAULT 1,
  phase_started_at TIMESTAMPTZ DEFAULT NOW(),
  days_running INT DEFAULT 0,
  autopilot_enabled BOOLEAN DEFAULT TRUE,
  spend_today NUMERIC DEFAULT 0,
  spend_total NUMERIC DEFAULT 0,
  clicks_today INT DEFAULT 0,
  clicks_total INT DEFAULT 0,
  results_today INT DEFAULT 0,
  results_total INT DEFAULT 0,
  impressions_today INT DEFAULT 0,
  ctr NUMERIC,
  cpr NUMERIC,
  roas NUMERIC,
  last_synced TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. AD COPIES (untuk A/B test)
CREATE TABLE ad_copies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id),
  headline TEXT,
  primary_text TEXT,
  description TEXT,
  status TEXT DEFAULT 'testing' CHECK (status IN ('testing', 'winner', 'paused', 'archived')),
  ab_test BOOLEAN DEFAULT FALSE,
  meta_ad_id TEXT,
  ctr NUMERIC,
  cpr NUMERIC,
  spend NUMERIC DEFAULT 0,
  clicks INT DEFAULT 0,
  impressions INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. AUTOPILOT SCHEME (otak/skema per user)
CREATE TABLE autopilot_scheme (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  phase1 TEXT,
  phase2 TEXT,
  phase3 TEXT,
  target_cpr NUMERIC,
  target_roas NUMERIC,
  phase1_days INT DEFAULT 3,
  phase2_days INT DEFAULT 4,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. AUTOPILOT RULES
CREATE TABLE autopilot_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('gt', 'lt', 'gte', 'lte')),
  value NUMERIC NOT NULL,
  action_type TEXT NOT NULL,
  action_value TEXT,
  scope TEXT DEFAULT 'all',
  is_active BOOLEAN DEFAULT TRUE,
  times_triggered INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. ACTION LOGS
CREATE TABLE action_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  campaign_id UUID REFERENCES campaigns(id),
  campaign_name TEXT,
  action_type TEXT NOT NULL,
  description TEXT,
  reason TEXT,
  status TEXT DEFAULT 'success',
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. NOTIF SETTINGS
CREATE TABLE notif_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  notif_pause BOOLEAN DEFAULT TRUE,
  notif_scale BOOLEAN DEFAULT TRUE,
  notif_create BOOLEAN DEFAULT TRUE,
  notif_winner BOOLEAN DEFAULT TRUE,
  notif_budget BOOLEAN DEFAULT TRUE,
  notif_daily BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- RLS (Row Level Security)
-- ============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_scheme ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notif_settings ENABLE ROW LEVEL SECURITY;

-- Profiles: bisa lihat semua, edit sendiri
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (TRUE);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- App Config: hanya sendiri
CREATE POLICY "config_own" ON app_config USING (auth.uid() = user_id);

-- Content Library: advertiser lihat milik sendiri, admin lihat semua
CREATE POLICY "library_select" ON content_library FOR SELECT USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);
CREATE POLICY "library_insert" ON content_library FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "library_update" ON content_library FOR UPDATE USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);
CREATE POLICY "library_delete" ON content_library FOR DELETE USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);

-- Campaigns: same pattern
CREATE POLICY "campaigns_select" ON campaigns FOR SELECT USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);
CREATE POLICY "campaigns_insert" ON campaigns FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "campaigns_update" ON campaigns FOR UPDATE USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);

-- Ad Copies
CREATE POLICY "copies_select" ON ad_copies FOR SELECT USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);
CREATE POLICY "copies_insert" ON ad_copies FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "copies_update" ON ad_copies FOR UPDATE USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);

-- Autopilot Scheme & Rules
CREATE POLICY "scheme_own" ON autopilot_scheme USING (auth.uid() = user_id);
CREATE POLICY "rules_select" ON autopilot_rules FOR SELECT USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);
CREATE POLICY "rules_insert" ON autopilot_rules FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "rules_update" ON autopilot_rules FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "rules_delete" ON autopilot_rules FOR DELETE USING (auth.uid() = user_id);

-- Action Logs
CREATE POLICY "logs_select" ON action_logs FOR SELECT USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'superadmin'))
);
CREATE POLICY "logs_insert" ON action_logs FOR INSERT WITH CHECK (TRUE);

-- Notif Settings
CREATE POLICY "notif_own" ON notif_settings USING (auth.uid() = user_id);
