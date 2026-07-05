const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const supabase = require('./database');
const { getTasksForLive } = require('./tasks');
const { client: lineClient } = require('./lineClient');
const { checkAndNotify } = require('./scheduler');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

router.post('/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const filename = `${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('flyers').upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (error) return res.status(500).json({ error: error.message });
  const { data: { publicUrl } } = supabase.storage.from('flyers').getPublicUrl(filename);
  res.json({ url: publicUrl });
});

router.get('/songs', auth, (_req, res) => {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', 'Songs', 'Remind.txt'), 'utf8');
    const songs = txt.split(',').map(s => s.trim()).filter(Boolean);
    res.json(songs);
  } catch {
    res.json([]);
  }
});

router.get('/songs/detail', auth, async (_req, res) => {
  const { data, error } = await supabase.from('songs').select('*').order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/lives/:id/setlist-image', auth, upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const drum = req.query.drum || '2tam';
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const filename = `setlist-${id}-${drum}.png`;
  const { error: upErr } = await supabase.storage
    .from('flyers')
    .upload(filename, req.file.buffer, { contentType: 'image/png', upsert: true });
  if (upErr) return res.status(500).json({ error: upErr.message });

  const { data: { publicUrl } } = supabase.storage.from('flyers').getPublicUrl(filename);

  const { error: liveErr } = await supabase
    .from('lives').update({ setlist_image_url: publicUrl }).eq('id', id);
  if (liveErr) return res.status(500).json({ error: liveErr.message });

  res.json({ ok: true, url: publicUrl });
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
  const { date, type, name, venue, description, flyer_url, setlist, notes, stage_time, drum_pattern, equipment, taiban } = req.body;
  const userId = process.env.CALENDAR_CHAT_ID || 'web';

  const { data: live, error } = await supabase
    .from('lives')
    .insert({ date, type, name: name || null, venue: venue || null, description: description || null, flyer_url: flyer_url || null, setlist: setlist || null, notes: notes || null, stage_time: stage_time || null, drum_pattern: drum_pattern || '2タム', equipment: equipment || null, taiban: taiban || null, user_id: userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const taskDefs = getTasksForLive(date, type);
  await supabase.from('tasks').insert(taskDefs.map((t) => ({ live_id: live.id, name: t.name, deadline: t.deadline })));

  const { data: tasks } = await supabase.from('tasks').select('*').eq('live_id', live.id).order('deadline');
  res.json({ ...live, tasks: tasks || [] });
});

router.put('/lives/:id', auth, async (req, res) => {
  const { date, type, name, venue, description, flyer_url, setlist, notes, stage_time, drum_pattern, equipment, taiban } = req.body;
  const fields = {};
  if (date !== undefined) fields.date = date;
  if (type !== undefined) fields.type = type;
  if (name !== undefined) fields.name = name || null;
  if (venue !== undefined) fields.venue = venue || null;
  if (description !== undefined) fields.description = description || null;
  if (flyer_url !== undefined) fields.flyer_url = flyer_url || null;
  if (setlist !== undefined) fields.setlist = setlist || null;
  if (notes !== undefined) fields.notes = notes || null;
  if (stage_time !== undefined) fields.stage_time = stage_time || null;
  if (drum_pattern !== undefined) fields.drum_pattern = drum_pattern || '2タム';
  if (equipment !== undefined) fields.equipment = equipment || null;
  if (taiban !== undefined) fields.taiban = taiban || null;

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
  const { title, date, location, time_range } = req.body;
  const userId = process.env.CALENDAR_CHAT_ID || 'web';
  const { data, error } = await supabase
    .from('events')
    .insert({ title, date, location: location || null, time_range: time_range || null, user_id: userId })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/events/:id', auth, async (req, res) => {
  const { title, date, location, time_range } = req.body;
  const fields = {};
  if (title !== undefined) fields.title = title;
  if (date !== undefined) fields.date = date;
  if (location !== undefined) fields.location = location || null;
  if (time_range !== undefined) fields.time_range = time_range || null;
  const { data, error } = await supabase.from('events').update(fields).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/events/:id', auth, async (req, res) => {
  const { error } = await supabase.from('events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---- Merch Items ----

router.get('/merch/items', auth, async (_req, res) => {
  const { data, error } = await supabase.from('merch_items').select('*').order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/merch/items', auth, async (req, res) => {
  const { name, price } = req.body;
  const { data, error } = await supabase.from('merch_items').insert({ name, price }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/merch/items/:id', auth, async (req, res) => {
  const { name, price, is_active } = req.body;
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (price !== undefined) fields.price = price;
  if (is_active !== undefined) fields.is_active = is_active;
  const { data, error } = await supabase.from('merch_items').update(fields).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/merch/items/:id', auth, async (req, res) => {
  const { error } = await supabase.from('merch_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---- Merch Sales ----

router.get('/merch/sales', auth, async (_req, res) => {
  const { data, error } = await supabase
    .from('merch_sales')
    .select('*, merch_items(name, price), lives(date, name, type)')
    .order('live_id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.get('/merch/sales/:live_id', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('merch_sales')
    .select('*, merch_items(name, price)')
    .eq('live_id', req.params.live_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/merch/sales', auth, async (req, res) => {
  const { live_id, items } = req.body; // items: [{item_id, quantity}]
  if (!live_id || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid body' });

  // 一度削除してから再挿入
  await supabase.from('merch_sales').delete().eq('live_id', live_id);
  const rows = items.filter(i => i.quantity > 0).map(i => ({ live_id, item_id: i.item_id, quantity: i.quantity }));
  if (rows.length > 0) {
    const { error } = await supabase.from('merch_sales').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
  }

  // LINE通知
  try {
    const { data: live } = await supabase.from('lives').select('date, name, type').eq('id', live_id).single();
    const { data: sales } = await supabase
      .from('merch_sales').select('quantity, merch_items(name, price)').eq('live_id', live_id);

    if (live && sales && sales.length > 0) {
      const liveName = live.name || live.type;
      const [y, m, d] = live.date.split('-');
      const dateStr = `${y}年${parseInt(m)}月${parseInt(d)}日`;

      let total = 0;
      const itemLines = sales.map(s => {
        const sub = s.quantity * s.merch_items.price;
        total += sub;
        return `・${s.merch_items.name}　${s.quantity}個　¥${sub.toLocaleString()}`;
      });

      // バック計算（アイテム名で照合）
      const qty = (keyword) => {
        const s = sales.find(s => s.merch_items.name.includes(keyword));
        return s ? s.quantity : 0;
      };
      const zenin = qty('全員チェキ');
      const anzai = 500 * qty('安西チェキ') + 250 * zenin;
      const seiya = 500 * qty('せいやチェキ') + 250 * zenin;
      const namo  = 500 * qty('なもチェキ')  + 250 * zenin;

      // ウォレット自動仕訳（再保存時は同ライブの自動仕訳を削除して再追加）
      await supabase.from('wallet_entries').delete().eq('live_id', live_id);
      const walletRows = [
        { date: live.date, description: `物販売上（${liveName}）`, amount: total, live_id },
      ];
      if (anzai > 0) walletRows.push({ date: live.date, description: `安西バック（${liveName}）`, amount: -anzai, live_id });
      if (seiya > 0) walletRows.push({ date: live.date, description: `せいやバック（${liveName}）`, amount: -seiya, live_id });
      if (namo  > 0) walletRows.push({ date: live.date, description: `なもバック（${liveName}）`, amount: -namo, live_id });
      await supabase.from('wallet_entries').insert(walletRows);

      const msg = [
        `🛒 物販売上報告`,
        `${dateStr}　${liveName}`,
        ``,
        itemLines.join('\n'),
        ``,
        `合計：¥${total.toLocaleString()}`,
        ``,
        `💰 バック`,
        `安西　¥${anzai.toLocaleString()}`,
        `せいや　¥${seiya.toLocaleString()}`,
        `なも　¥${namo.toLocaleString()}`,
      ].join('\n');

      const to = process.env.CALENDAR_CHAT_ID;
      if (to) await lineClient.pushMessage({ to, messages: [{ type: 'text', text: msg }] });
    }
  } catch (e) {
    console.error('物販LINE通知失敗:', e.message);
  }

  res.json({ ok: true });
});

// ---- Live Videos ----

router.get('/videos', auth, async (_req, res) => {
  const { data, error } = await supabase.from('live_videos').select('*').order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/videos', auth, async (req, res) => {
  const { date, live_name, venue, youtube_url, setlist, live_id } = req.body;
  const { data, error } = await supabase.from('live_videos')
    .insert({ date, live_name, venue: venue || null, youtube_url, setlist: setlist || null, live_id: live_id || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/videos/:id', auth, async (req, res) => {
  const { date, live_name, venue, youtube_url, setlist, live_id } = req.body;
  const { data, error } = await supabase.from('live_videos')
    .update({ date, live_name, venue: venue || null, youtube_url, setlist: setlist || null, live_id: live_id || null })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/videos/:id', auth, async (req, res) => {
  const { error } = await supabase.from('live_videos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---- Wallet ----

router.get('/wallet', auth, async (_req, res) => {
  const { data, error } = await supabase.from('wallet_entries').select('*').order('date', { ascending: false }).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/wallet', auth, async (req, res) => {
  const { date, description, amount, live_id } = req.body;
  const { data, error } = await supabase.from('wallet_entries')
    .insert({ date, description, amount, live_id: live_id || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/wallet/:id', auth, async (req, res) => {
  const { error } = await supabase.from('wallet_entries').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 手動トリガー（テスト用）
router.post('/debug/notify', auth, async (_req, res) => {
  try {
    await checkAndNotify();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
