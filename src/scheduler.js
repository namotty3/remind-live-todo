const cron = require('node-cron');
const supabase = require('./database');

function todayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

function tomorrowJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
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

function initScheduler(client) {
  cron.schedule('0 0 * * *', () => checkAndNotify(client));
  console.log('スケジューラー起動（毎日9:00 JST）');
}

async function checkAndNotify(client) {
  await notifyOverdueTasks(client);
  await notifyTomorrowEvents(client);
  await notifyUpcomingLives(client);
}

function buildLiveReminderFlex(live) {
  const bodyContents = [
    { type: 'text', text: `📅 ${formatDate(live.date)}`, size: 'sm', color: '#333333' },
    { type: 'text', text: `🎵 ${live.type}`, size: 'sm', color: '#333333', margin: 'sm' }
  ];
  if (live.venue)       bodyContents.push({ type: 'text', text: `📍 ${live.venue}`,       size: 'sm', color: '#333333', margin: 'sm' });
  if (live.description) bodyContents.push({ type: 'text', text: `📝 ${live.description}`, size: 'sm', color: '#666666', margin: 'md', wrap: true });
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

async function notifyUpcomingLives(client) {
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
        await client.pushMessage({ to: userId, messages: [buildLiveReminderFlex(live)] });
      } catch (err) {
        console.error(`ライブリマインド失敗 userId=${userId}:`, err.message);
      }
    }
  }
}

async function notifyOverdueTasks(client) {
  const today = todayJST();
  const twoDaysAgo = new Date(Date.now() + 9 * 60 * 60 * 1000 - 2 * 24 * 60 * 60 * 1000);
  const twoDaysAgoStr = twoDaysAgo.toISOString().replace('T', ' ').split('.')[0];

  const { data: overdueTasks, error } = await supabase
    .from('tasks')
    .select('id, name, deadline, live_id, lives!inner(date, type, user_id)')
    .eq('is_done', false)
    .lt('deadline', today)
    .or(`last_notified.is.null,last_notified.lte.${twoDaysAgoStr}`);

  if (error || !overdueTasks || overdueTasks.length === 0) return;

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
      await supabase.from('tasks').update({ last_notified: now }).in('id', notifiedIds);
    } catch (err) {
      console.error(`通知失敗 userId=${userId}:`, err.message);
    }
  }
}

async function notifyTomorrowEvents(client) {
  const tomorrow = tomorrowJST();

  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('date', tomorrow);

  if (error || !events || events.length === 0) return;

  const byUser = {};
  for (const ev of events) {
    if (!byUser[ev.user_id]) byUser[ev.user_id] = [];
    byUser[ev.user_id].push(ev);
  }

  for (const [userId, evs] of Object.entries(byUser)) {
    let msg = '📅 明日の予定\n\n';
    for (const ev of evs) {
      msg += `・${ev.title}`;
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

module.exports = { initScheduler, checkAndNotify };
