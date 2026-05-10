-- APEX CRM Tables
-- Run this in your Supabase SQL editor

-- Agents table
CREATE TABLE IF NOT EXISTS apex_agents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  status TEXT DEFAULT 'offline' CHECK (status IN ('offline', 'available', 'on_call', 'wrap_up')),
  sip_username TEXT,
  current_call_id UUID,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Leads table
CREATE TABLE IF NOT EXISTS apex_leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT,
  business_name TEXT,
  phone TEXT NOT NULL,
  state TEXT,
  lead_type TEXT,
  lead_score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'contacted', 'callback', 'dnc', 'funded')),
  assigned_to UUID REFERENCES apex_agents(id),
  last_disposition TEXT,
  callback_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Calls table
CREATE TABLE IF NOT EXISTS apex_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID REFERENCES apex_agents(id),
  lead_id UUID REFERENCES apex_leads(id),
  phone_number TEXT,
  telnyx_call_id TEXT,
  conference_id TEXT,
  direction TEXT DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'initiated' CHECK (status IN ('initiated', 'ringing', 'answered', 'ended', 'failed')),
  disposition TEXT CHECK (disposition IN ('Answered', 'No Answer', 'Callback', 'Not Interested', 'App Sent', 'App Signed', 'Funded', 'DNC')),
  duration INTEGER,
  recording_url TEXT,
  notes TEXT,
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  disposed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scripts table
CREATE TABLE IF NOT EXISTS apex_scripts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  lead_type TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed agents
INSERT INTO apex_agents (name, username, password, role, sip_username) VALUES
  ('Jordan', 'jordan', 'CHANGE_ME', 'admin', 'apexjordan'),
  ('Brent', 'brent', 'CHANGE_ME', 'agent', 'apexbrent'),
  ('Glenn', 'glenn', 'CHANGE_ME', 'agent', 'apexglenn'),
  ('Jessica', 'jessica', 'CHANGE_ME', 'agent', 'apexjessica'),
  ('Kemain', 'kemain', 'CHANGE_ME', 'agent', 'apexkemain'),
  ('Agent 1', 'agent1', 'CHANGE_ME', 'agent', 'apexagent1'),
  ('Agent 2', 'agent2', 'CHANGE_ME', 'agent', 'apexagent2'),
  ('Agent 3', 'agent3', 'CHANGE_ME', 'agent', 'apexagent3')
ON CONFLICT (username) DO NOTHING;

-- Seed default script
INSERT INTO apex_scripts (title, content, lead_type) VALUES
  ('MCA Default Script', 
   'Hi, may I speak with [Business Owner Name]?

[Introduction]
Hi [Name], my name is [Agent Name] calling from Swift Path Capital. How are you today?

[Opening]
The reason for my call is that your business was recently pre-approved for working capital funding up to $250,000. This is based on your business revenue — there''s no collateral required and funding can happen in as little as 24 hours.

[Qualify]
Can I ask — are you currently the decision maker for your business finances?
What does your average monthly revenue look like?
Have you worked with alternative funding before?

[Close]
Based on what you''ve told me, you''d be a great fit. I can send you a 1-page application right now — it takes about 2 minutes to fill out. What''s the best email for you?',
   'MCA')
ON CONFLICT DO NOTHING;

-- Enable RLS (optional but recommended)
ALTER TABLE apex_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE apex_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE apex_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE apex_scripts ENABLE ROW LEVEL SECURITY;

-- Allow all for service role (backend uses service key)
CREATE POLICY "Service role full access" ON apex_agents FOR ALL USING (true);
CREATE POLICY "Service role full access" ON apex_leads FOR ALL USING (true);
CREATE POLICY "Service role full access" ON apex_calls FOR ALL USING (true);
CREATE POLICY "Service role full access" ON apex_scripts FOR ALL USING (true);
