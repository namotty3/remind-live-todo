const cron = require('node-cron');
const supabase = require('./database');
const { client } = require('./lineClient');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function todayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}


function nowJSTString() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('T', ' ').split('.')[0];
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function initScheduler() {
  cron.schedule('0 0 * * *', () => checkAndNotify());
  cron.schedule('*/5 * * * *', () => checkNewEmails().catch(e => console.error('[メールチェックエラー]', e.message)));
  console.log('スケジューラー起動（毎日9:00 JST + メール5分ごと）');
}

async function checkAndNotify() {
  console.log(`[${new Date().toISOString()}] checkAndNotify 開始`);
  await notifyOverdueTasks();
  await notifyUpcomingEvents();
  await notifyUpcomingLives();
  console.log(`[${new Date().toISOString()}] checkAndNotify 完了`);
}

function buildLiveReminderFlex(live) {
  const bodyContents = [
    { type: 'text', text: `📅 ${formatDate(live.date)}`, size: 'sm', color: '#333333' },
    { type: 'text', text: `🎵 ${live.type}`, size: 'sm', color: '#333333', margin: 'sm' }
  ];
  if (live.venue)       bodyContents.push({ type: 'text', text: `📍 ${live.venue}`,       size: 'sm', color: '#333333', margin: 'sm' });
  if (live.description) bodyContents.push({ type: 'text', text: `📝 ${live.description}`, size: 'sm', color: '#666666', margin: 'md', wrap: true });
  if (live.setlist) {
    const songs = live.setlist.split(',').map((s, i) => `${i + 1}. ${s.trim()}`).join('\n');
    bodyContents.push({ type: 'text', text: `🎵 セトリ\n${songs}`, size: 'sm', color: '#333333', margin: 'md', wrap: true });
  }
  if (live.notes)       bodyContents.push({ type: 'text', text: `📌 ${live.notes}`,       size: 'sm', color: '#666666', margin: 'sm', wrap: true });
  if (live.flyer_url)   bodyContents.push({ type: 'button', action: { type: 'uri', label: '🖼️ フライヤーを見る', uri: live.flyer_url }, style: 'secondary', margin: 'md' });

  return {
    type: 'flex',
    altText: `🔔 2日後のライブ: ${live.name || formatDate(live.date)}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#FF8C00', paddingAll: 'lg',
        contents: [
          { type: 'text', text: '🔔 2日後のライブリマインド', color: '#ffffff', size: 'sm' },
          { type: 'text', text: live.name || formatDate(live.date), color: '#ffffff', weight: 'bold', size: 'lg', wrap: true }
        ]
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents }
    }
  };
}

async function notifyUpcomingLives() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jst.setDate(jst.getDate() + 2);
  const twoDaysLater = jst.toISOString().split('T')[0];

  const { data: lives, error } = await supabase.from('lives').select('*').eq('date', twoDaysLater);
  if (error || !lives || lives.length === 0) return;

  const byUser = {};
  for (const live of lives) {
    if (!byUser[live.user_id]) byUser[live.user_id] = [];
    byUser[live.user_id].push(live);
  }

  for (const [userId, ls] of Object.entries(byUser)) {
    for (const live of ls) {
      try {
        const messages = [buildLiveReminderFlex(live)];
        if (live.flyer_url) messages.push({ type: 'image', originalContentUrl: live.flyer_url, previewImageUrl: live.flyer_url });
        await client.pushMessage({ to: userId, messages });
      } catch (err) {
        console.error(`ライブリマインド失敗 userId=${userId}:`, err.message);
      }
    }
  }
}

async function notifyOverdueTasks() {
  const today = todayJST();
  // ISO形式（Tあり）でないとSupabaseの.or()フィルターが壊れる
  const twoDaysAgo = new Date(Date.now() + 9 * 60 * 60 * 1000 - 2 * 24 * 60 * 60 * 1000);
  const twoDaysAgoStr = twoDaysAgo.toISOString();

  const { data: overdueTasks, error } = await supabase
    .from('tasks')
    .select('id, name, deadline, live_id, lives!inner(date, type, user_id)')
    .eq('is_done', false)
    .lt('deadline', today)
    .or(`last_notified.is.null,last_notified.lte.${twoDaysAgoStr}`);

  if (error) {
    console.error('overdueTasks クエリエラー:', error.message);
    return;
  }
  console.log(`overdueTasks 件数: ${overdueTasks ? overdueTasks.length : 0}`);
  if (!overdueTasks || overdueTasks.length === 0) return;

  const byUser = {};
  for (const task of overdueTasks) {
    const { user_id, date, type } = task.lives;
    if (!byUser[user_id]) byUser[user_id] = {};
    if (!byUser[user_id][task.live_id]) {
      byUser[user_id][task.live_id] = { liveDate: date, liveType: type, tasks: [] };
    }
    byUser[user_id][task.live_id].tasks.push(task);
  }

  const now = nowJSTString();

  for (const [userId, lives] of Object.entries(byUser)) {
    let msg = '⚠️ 未完了タスクのお知らせ\n\n';
    for (const liveData of Object.values(lives)) {
      msg += `📅 ${formatDate(liveData.liveDate)}（${liveData.liveType}）\n`;
      for (const task of liveData.tasks) {
        const daysOver = Math.floor((Date.now() - new Date(task.deadline).getTime()) / 86400000);
        msg += `・${task.name}（${daysOver}日超過）\n  タスクID: ${task.id}\n`;
      }
      msg += '\n';
    }
    msg += 'チェックするには\n「チェック [タスクID]」';

    try {
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: msg }] });
      const notifiedIds = overdueTasks.filter((t) => t.lives.user_id === userId).map((t) => t.id);
      await supabase.from('tasks').update({ last_notified: new Date().toISOString() }).in('id', notifiedIds);
    } catch (err) {
      console.error(`通知失敗 userId=${userId}:`, err.message);
    }
  }
}

async function notifyUpcomingEvents() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jst.setDate(jst.getDate() + 2);
  const twoDaysLater = jst.toISOString().split('T')[0];

  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('date', twoDaysLater);

  if (error || !events || events.length === 0) return;

  const byUser = {};
  for (const ev of events) {
    if (!byUser[ev.user_id]) byUser[ev.user_id] = [];
    byUser[ev.user_id].push(ev);
  }

  for (const [userId, evs] of Object.entries(byUser)) {
    let msg = '📅 2日後の予定\n\n';
    for (const ev of evs) {
      msg += `・${ev.title}`;
      if (ev.time_range) msg += `\n  🕐 ${ev.time_range}`;
      if (ev.location) msg += `\n  📍 ${ev.location}`;
      msg += '\n';
    }

    try {
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: msg }] });
    } catch (err) {
      console.error(`予定通知失敗 userId=${userId}:`, err.message);
    }
  }
}

async function checkNewEmails() {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  const to = process.env.CALENDAR_CHAT_ID;
  if (!gmailUser || !gmailPass || !to) return;

  const imap = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
    logger: false,
  });

  try {
    await imap.connect();
    const lock = await imap.getMailboxLock('INBOX');
    try {
      const uids = await imap.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return;

      // 最大5件に絞る（古いものから順）
      const targets = uids.slice(0, 5);
      console.log(`[メールチェック] 未読 ${uids.length} 件（最大5件処理）`);

      for await (const msg of imap.fetch(targets.join(','), { source: true }, { uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const from = parsed.from?.text || '不明';
          const subject = parsed.subject || '(件名なし)';
          const dateStr = parsed.date
            ? parsed.date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
            : '';
          const body = (parsed.text || '').replace(/\r\n/g, '\n').trim();
          const bodyPreview = body.length > 300 ? body.slice(0, 300) + '…' : body;

          const lines = [
            '📧 新着メール',
            '',
            `差出人: ${from}`,
            `件名: ${subject}`,
          ];
          if (dateStr) lines.push(`受信: ${dateStr}`);
          if (bodyPreview) lines.push('', '─────', bodyPreview);

          await client.pushMessage({ to, messages: [{ type: 'text', text: lines.join('\n') }] });
          await imap.messageFlagsAdd(`${msg.uid}`, ['\\Seen'], { uid: true });
          console.log(`[メール通知] 件名: ${subject} → 送信完了`);
        } catch (parseErr) {
          console.error('[メール解析エラー]', parseErr.message);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error('[Gmail接続エラー]', e.message);
  } finally {
    await imap.logout().catch(() => {});
  }
}

module.exports = { initScheduler, checkAndNotify };
