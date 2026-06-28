const cron = require('node-cron');
const supabase = require('./database');

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

function initScheduler(client) {
  // 毎日 0:00 UTC = 9:00 JST に実行
  cron.schedule('0 0 * * *', () => checkAndNotify(client));
  console.log('スケジューラー起動（毎日9:00 JST）');
}

async function checkAndNotify(client) {
  const today = todayJST();
  const twoDaysAgo = new Date(Date.now() + 9 * 60 * 60 * 1000 - 2 * 24 * 60 * 60 * 1000);
  const twoDaysAgoStr = twoDaysAgo.toISOString().replace('T', ' ').split('.')[0];

  // 期限切れ・未完了・2日以上通知していないタスクをLIVE情報付きで取得
  const { data: overdueTasks, error } = await supabase
    .from('tasks')
    .select('id, name, deadline, live_id, lives!inner(date, type, user_id)')
    .eq('is_done', false)
    .lt('deadline', today)
    .or(`last_notified.is.null,last_notified.lte.${twoDaysAgoStr}`);

  if (error || !overdueTasks || overdueTasks.length === 0) return;

  // ユーザーごとにグループ化
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

      const notifiedIds = overdueTasks
        .filter((t) => t.lives.user_id === userId)
        .map((t) => t.id);

      await supabase.from('tasks').update({ last_notified: now }).in('id', notifiedIds);
    } catch (err) {
      console.error(`通知失敗 userId=${userId}:`, err.message);
    }
  }
}

module.exports = { initScheduler, checkAndNotify };
