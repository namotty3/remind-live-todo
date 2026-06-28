const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const supabase = require('./database');
const { getTasksForLive } = require('./tasks');

router.get('/songs', auth, (_req, res) => {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', 'Songs', 'Remind.txt'), 'utf8');
    const songs = txt.split(',').map(s => s.trim()).filter(Boolean);
    res.json(songs);
  } catch {
    res.json([]);
  }
});

function auth(req, res, next) {
  const pw = req.headers['x-password'];
  if (!process.env.CALENDAR_PASSWORD || pw !== process.env.CALENDAR_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.post('/auth', (req, res) => {
  if (req.body.password === process.env.CALENDAR_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

router.get('/lives', auth, async (req, res) => {
  const { data: lives, error } = await supabase.from('lives').select('*').order('date');
  if (error) return res.status(500).json({ error: error.message });

  const liveIds = (lives || []).map((l) => l.id);
  const { data: tasks } = liveIds.length
    ? await supabase.from('tasks').select('*').in('live_id', liveIds).order('deadline')
    : { data: [] };

  res.json((lives || []).map((l) => ({ ...l, tasks: (tasks || []).filter((t) => t.live_id === l.id) })));
});

router.post('/lives', auth, async (req, res) => {
  const { date, type, name, venue, description, flyer_url, setlist, notes } = req.body;
  const userId = process.env.CALENDAR_CHAT_ID || 'web';

  const { data: live, error } = await supabase
    .from('lives')
    .insert({ date, type, name: name || null, venue: venue || null, description: description || null, flyer_url: flyer_url || null, setlist: setlist || null, notes: notes || null, user_id: userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const taskDefs = getTasksForLive(date, type);
  await supabase.from('tasks').insert(taskDefs.map((t) => ({ live_id: live.id, name: t.name, deadline: t.deadline })));

  const { data: tasks } = await supabase.from('tasks').select('*').eq('live_id', live.id).order('deadline');
  res.json({ ...live, tasks: tasks || [] });
});

router.put('/lives/:id', auth, async (req, res) => {
  const { date, type, name, venue, description, flyer_url, setlist, notes } = req.body;
  const fields = {};
  if (date !== undefined) fields.date = date;
  if (type !== undefined) fields.type = type;
  if (name !== undefined) fields.name = name || null;
  if (venue !== undefined) fields.venue = venue || null;
  if (description !== undefined) fields.description = description || null;
  if (flyer_url !== undefined) fields.flyer_url = flyer_url || null;
  if (setlist !== undefined) fields.setlist = setlist || null;
  if (notes !== undefined) fields.notes = notes || null;

  const { data: live, error } = await supabase.from('lives').update(fields).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(live);
});

router.delete('/lives/:id', auth, async (req, res) => {
  const { error } = await supabase.from('lives').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.put('/tasks/:id/done', auth, async (req, res) => {
  const { error } = await supabase.from('tasks').update({ is_done: req.body.is_done }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---- Events ----

router.get('/events', auth, async (req, res) => {
  const { data, error } = await supabase.from('events').select('*').order('date');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/events', auth, async (req, res) => {
  const { title, date, location } = req.body;
  const userId = process.env.CALENDAR_CHAT_ID || 'web';
  const { data, error } = await supabase
    .from('events')
    .insert({ title, date, location: location || null, user_id: userId })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/events/:id', auth, async (req, res) => {
  const { title, date, location } = req.body;
  const fields = {};
  if (title !== undefined) fields.title = title;
  if (date !== undefined) fields.date = date;
  if (location !== undefined) fields.location = location || null;
  const { data, error } = await supabase.from('events').update(fields).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/events/:id', auth, async (req, res) => {
  const { error } = await supabase.from('events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
