const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const telnyx = require('telnyx');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Init clients
const telnyxClient = telnyx(process.env.TELNYX_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const APP_ID = process.env.TELNYX_APP_ID;
const OUTBOUND_PROFILE_ID = process.env.TELNYX_OUTBOUND_PROFILE_ID;

// ─── AUTH ────────────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { data: agent, error } = await supabase
    .from('apex_agents')
    .select('*')
    .eq('username', username)
    .eq('password', password)
    .single();
  if (error || !agent) return res.status(401).json({ error: 'Invalid credentials' });
  await supabase.from('apex_agents').update({ status: 'available', last_seen: new Date() }).eq('id', agent.id);
  res.json({ agent });
});

app.post('/api/logout', async (req, res) => {
  const { agent_id } = req.body;
  await supabase.from('apex_agents').update({ status: 'offline' }).eq('id', agent_id);
  res.json({ success: true });
});

// ─── LEADS ───────────────────────────────────────────────────────────────────

// Get next lead for agent (only after dispo)
app.get('/api/leads/next', async (req, res) => {
  const { agent_id } = req.query;

  // Check if agent has undisposed call
  const { data: openCall } = await supabase
    .from('apex_calls')
    .select('*')
    .eq('agent_id', agent_id)
    .is('disposition', null)
    .not('status', 'eq', 'initiated')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (openCall) return res.status(403).json({ error: 'Dispose current call first' });

  const { data: lead } = await supabase
    .from('apex_leads')
    .select('*')
    .eq('status', 'new')
    .is('assigned_to', null)
    .order('lead_score', { ascending: false })
    .limit(1)
    .single();

  if (!lead) return res.status(404).json({ error: 'No leads available' });

  await supabase.from('apex_leads').update({ assigned_to: agent_id, status: 'in_progress' }).eq('id', lead.id);
  res.json({ lead });
});

app.get('/api/leads/current', async (req, res) => {
  const { agent_id } = req.query;
  const { data: lead } = await supabase
    .from('apex_leads')
    .select('*')
    .eq('assigned_to', agent_id)
    .eq('status', 'in_progress')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  res.json({ lead });
});

// ─── CALLS ───────────────────────────────────────────────────────────────────

app.post('/api/calls/dial', async (req, res) => {
  const { agent_id, lead_id, phone_number, sip_username } = req.body;

  try {
    // Create a conference room for this call (enables whisper/barge/monitor)
    const conference_id = `apex-${Date.now()}`;

    // First leg: call the external number
    const outboundCall = await telnyxClient.calls.create({
      connection_id: APP_ID,
      to: phone_number,
      from: process.env.TELNYX_CALLER_ID,
      webhook_url: `${process.env.BASE_URL}/webhook`,
      custom_headers: [{ name: 'X-Conference-Id', value: conference_id }],
    });

    // Log call in DB
    const { data: callLog } = await supabase.from('apex_calls').insert({
      agent_id,
      lead_id,
      phone_number,
      telnyx_call_id: outboundCall.data.call_leg_id,
      conference_id,
      status: 'initiated',
      direction: 'outbound',
    }).select().single();

    // Update agent status
    await supabase.from('apex_agents').update({ status: 'on_call', current_call_id: callLog.id }).eq('id', agent_id);

    // Notify admin dashboard
    io.emit('agent_status_change', { agent_id, status: 'on_call', call_id: callLog.id });

    res.json({ call: callLog, conference_id });
  } catch (err) {
    console.error('Dial error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calls/hangup', async (req, res) => {
  const { call_id, telnyx_call_id } = req.body;
  try {
    await telnyxClient.calls.hangup(telnyx_call_id);
    await supabase.from('apex_calls').update({ status: 'ended', ended_at: new Date() }).eq('id', call_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calls/disposition', async (req, res) => {
  const { call_id, agent_id, lead_id, disposition, notes } = req.body;

  await supabase.from('apex_calls').update({ disposition, notes, disposed_at: new Date() }).eq('id', call_id);
  await supabase.from('apex_leads').update({ status: disposition === 'DNC' ? 'dnc' : 'contacted', last_disposition: disposition, notes }).eq('id', lead_id);
  await supabase.from('apex_agents').update({ status: 'available', current_call_id: null }).eq('id', agent_id);

  io.emit('agent_status_change', { agent_id, status: 'available' });
  res.json({ success: true });
});

// ─── SUPERVISOR CONTROLS ─────────────────────────────────────────────────────

app.post('/api/supervisor/monitor', async (req, res) => {
  const { conference_id, supervisor_sip } = req.body;
  // Join conference as silent listener
  try {
    const call = await telnyxClient.calls.create({
      connection_id: APP_ID,
      to: `sip:${supervisor_sip}@sip.telnyx.com`,
      from: process.env.TELNYX_CALLER_ID,
      webhook_url: `${process.env.BASE_URL}/webhook`,
      custom_headers: [
        { name: 'X-Conference-Id', value: conference_id },
        { name: 'X-Supervisor-Mode', value: 'monitor' }
      ],
    });
    res.json({ success: true, call_leg_id: call.data.call_leg_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supervisor/whisper', async (req, res) => {
  const { conference_id, supervisor_sip } = req.body;
  try {
    const call = await telnyxClient.calls.create({
      connection_id: APP_ID,
      to: `sip:${supervisor_sip}@sip.telnyx.com`,
      from: process.env.TELNYX_CALLER_ID,
      webhook_url: `${process.env.BASE_URL}/webhook`,
      custom_headers: [
        { name: 'X-Conference-Id', value: conference_id },
        { name: 'X-Supervisor-Mode', value: 'whisper' }
      ],
    });
    res.json({ success: true, call_leg_id: call.data.call_leg_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supervisor/barge', async (req, res) => {
  const { conference_id, supervisor_sip } = req.body;
  try {
    const call = await telnyxClient.calls.create({
      connection_id: APP_ID,
      to: `sip:${supervisor_sip}@sip.telnyx.com`,
      from: process.env.TELNYX_CALLER_ID,
      webhook_url: `${process.env.BASE_URL}/webhook`,
      custom_headers: [
        { name: 'X-Conference-Id', value: conference_id },
        { name: 'X-Supervisor-Mode', value: 'barge' }
      ],
    });
    res.json({ success: true, call_leg_id: call.data.call_leg_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN ───────────────────────────────────────────────────────────────────

app.get('/api/admin/agents', async (req, res) => {
  const { data } = await supabase
    .from('apex_agents')
    .select('id, name, username, role, status, current_call_id, last_seen')
    .order('name');
  res.json({ agents: data });
});

app.get('/api/admin/calls/live', async (req, res) => {
  const { data } = await supabase
    .from('apex_calls')
    .select('*, apex_agents(name), apex_leads(name, business_name, phone)')
    .eq('status', 'answered')
    .order('created_at', { ascending: false });
  res.json({ calls: data });
});

app.get('/api/admin/stats', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const { data: calls } = await supabase
    .from('apex_calls')
    .select('disposition, duration')
    .gte('created_at', today);

  const stats = {
    total_calls: calls?.length || 0,
    answered: calls?.filter(c => c.disposition === 'Answered').length || 0,
    no_answer: calls?.filter(c => c.disposition === 'No Answer').length || 0,
    callbacks: calls?.filter(c => c.disposition === 'Callback').length || 0,
    app_sent: calls?.filter(c => c.disposition === 'App Sent').length || 0,
    app_signed: calls?.filter(c => c.disposition === 'App Signed').length || 0,
    funded: calls?.filter(c => c.disposition === 'Funded').length || 0,
  };
  res.json({ stats });
});

app.get('/api/scripts', async (req, res) => {
  const { data } = await supabase.from('apex_scripts').select('*').eq('active', true);
  res.json({ scripts: data });
});

// ─── TELNYX WEBHOOK ──────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const event = req.body?.data;
  if (!event) return res.sendStatus(200);

  const { event_type, payload } = event;
  const call_leg_id = payload?.call_leg_id;
  const conference_id = payload?.custom_headers?.find(h => h.name === 'X-Conference-Id')?.value;
  const supervisor_mode = payload?.custom_headers?.find(h => h.name === 'X-Supervisor-Mode')?.value;

  console.log('Webhook event:', event_type, call_leg_id);

  try {
    switch (event_type) {

      case 'call.initiated':
        await supabase.from('apex_calls').update({ status: 'ringing' }).eq('telnyx_call_id', call_leg_id);
        io.emit('call_update', { call_leg_id, status: 'ringing' });
        break;

      case 'call.answered':
        // Move both legs into conference
        if (conference_id) {
          const muted = supervisor_mode === 'monitor';
          const coach = supervisor_mode === 'whisper';

          await telnyxClient.calls.join_conference(call_leg_id, {
            call_control_id: call_leg_id,
            conference_name: conference_id,
            muted,
            coach,
          });
        }

        await supabase.from('apex_calls')
          .update({ status: 'answered', answered_at: new Date() })
          .eq('telnyx_call_id', call_leg_id);

        io.emit('call_update', { call_leg_id, status: 'answered', conference_id });
        break;

      case 'call.recording.saved':
        await supabase.from('apex_calls').update({
          recording_url: payload.recording_urls?.mp3
        }).eq('telnyx_call_id', call_leg_id);
        break;

      case 'call.hangup':
        const duration = payload?.end_time && payload?.start_time
          ? Math.round((new Date(payload.end_time) - new Date(payload.start_time)) / 1000)
          : null;

        await supabase.from('apex_calls')
          .update({ status: 'ended', ended_at: new Date(), duration })
          .eq('telnyx_call_id', call_leg_id);

        io.emit('call_update', { call_leg_id, status: 'ended', duration });

        // Find agent and notify
        const { data: callData } = await supabase
          .from('apex_calls')
          .select('agent_id')
          .eq('telnyx_call_id', call_leg_id)
          .single();

        if (callData) {
          io.emit('call_ended', { agent_id: callData.agent_id, call_leg_id });
        }
        break;

      case 'call.speak.ended':
      case 'call.bridged':
        io.emit('call_update', { call_leg_id, status: event_type });
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.sendStatus(200);
});

app.post('/webhook-failover', (req, res) => res.sendStatus(200));

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('agent_join', async (agent_id) => {
    socket.join(`agent_${agent_id}`);
    socket.join('admin');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`APEX CRM running on port ${PORT}`));
