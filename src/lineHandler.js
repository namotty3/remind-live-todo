const supabase = require('./database');
const { getTasksForLive } = require('./tasks');

function todayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

function getChatId(source) {
  if (source.type === 'group') return source.groupId;
  if (source.type === 'room')  return source.roomId;
  return source.userId;
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

// ---- セッション管理 ----

async function getSession(chatId) {
  const { data } = await supabase.from('sessions').select('*').eq('chat_id', chatId).single();
  return data;
}

async function setSession(chatId, step, data) {
  await supabase.from('sessions').upsert({ chat_id: chatId, step, data, updated_at: new Date().toISOString() });
}

async function clearSession(chatId) {
  await supabase.from('sessions').delete().eq('chat_id', chatId);
}

// ---- メッセージイベント ----

async function handleMessage(event, client) {
  const text = event.message.text.trim();
  const userId = getChatId(event.source);
  const replyToken = event.replyToken;

  const reply = (messages) =>
    client.replyMessage({ replyToken, messages: Array.isArray(messages) ? messages : [messages] });

  // セッション中の入力を最優先で処理
  const session = await getSession(userId);
  if (session) return handleSessionInput(session, text, userId, reply);

  if (text === 'メニュー' || text === 'menu')            return reply(buildMenu());
  if (text === 'ライブ追加' || text === '追加')          return reply(buildTypeSelection());
  if (text === 'ライブ一覧' || text === '一覧')          return handleListLives(userId, reply);
  if (text === 'ライブ削除' || text === '削除')          return handleListLivesForDelete(userId, reply);
  if (/^タスク \d+$/.test(text))                         return handleShowTasks(parseInt(text.split(' ')[1]), userId, reply);
  if (/^チェック解除 \d+$/.test(text))                   return handleUncheck(parseInt(text.split(' ')[1]), userId, reply);
  if (/^チェック \d+$/.test(text))                       return handleCheck(parseInt(text.split(' ')[1]), userId, reply);
  if (text === 'ヘルプ' || text === 'help')              return reply({ type: 'text', text: helpText() });
  if (text.startsWith('ライブ追加 '))                    return handleAddLiveText(text, userId, reply);
}

// ---- セッション入力ハンドラー ----

async function handleSessionInput(session, text, chatId, reply) {
  const isSkip = text === 'スキップ' || text === 'skip';

  if (session.step === 'awaiting_name') {
    const name = isSkip ? null : text;
    await setSession(chatId, 'awaiting_venue', { ...session.data, name });
    return reply({
      type: 'text',
      text: '📍 場所を入力してください（任意）',
      quickReply: {
        items: [{ type: 'action', action: { type: 'message', label: 'スキップ', text: 'スキップ' } }]
      }
    });
  }

  if (session.step === 'awaiting_venue') {
    const venue = isSkip ? null : text;
    const { date, type, name } = session.data;
    await clearSession(chatId);
    return handleAddLive(date, type, name, venue, chatId, reply);
  }
}

// ---- ポストバックイベント ----

async function handlePostback(event, client) {
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');
  const userId = getChatId(event.source);
  const replyToken = event.replyToken;

  const reply = (messages) =>
    client.replyMessage({ replyToken, messages: Array.isArray(messages) ? messages : [messages] });

  if (action === 'select_type') {
    return reply(buildDatePicker(decodeURIComponent(params.get('type'))));
  }

  if (action === 'set_date') {
    const liveType = decodeURIComponent(params.get('type'));
    const dateStr = event.postback.params.date;
    await setSession(userId, 'awaiting_name', { date: dateStr, type: liveType });
    return reply({
      type: 'text',
      text: `📅 ${formatDate(dateStr)}（${liveType}）\n\n🎤 ライブ名を入力してください（任意）`,
      quickReply: {
        items: [{ type: 'action', action: { type: 'message', label: 'スキップ', text: 'スキップ' } }]
      }
    });
  }

  if (action === 'cancel') {
    await clearSession(userId);
    return reply({ type: 'text', text: 'キャンセルしました。' });
  }

  if (action === 'confirm_delete') {
    const liveId = parseInt(params.get('live_id'));
    return handleConfirmDelete(liveId, userId, reply);
  }

  if (action === 'delete_live') {
    const liveId = parseInt(params.get('live_id'));
    return handleDeleteLive(liveId, userId, reply);
  }
}

// ---- GUIメッセージビルダー ----

function buildMenu() {
  const buttons = [
    { label: '➕ ライブ追加', text: 'ライブ追加', color: '#00B900' },
    { label: '📋 ライブ一覧', text: 'ライブ一覧', color: '#00B900' },
    { label: '🗑️ ライブ削除', text: 'ライブ削除', color: '#888888' },
    { label: '❓ ヘルプ',     text: 'ヘルプ',     color: '#888888' },
  ];

  return {
    type: 'flex',
    altText: 'メニュー',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#00B900',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '🎵 バンドライブToDo', color: '#ffffff', weight: 'bold', size: 'lg' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: buttons.map((b) => ({
          type: 'button',
          action: { type: 'message', label: b.label, text: b.text },
          style: 'primary',
          color: b.color
        }))
      }
    }
  };
}

function buildTypeSelection() {
  return {
    type: 'text',
    text: '🎵 ライブの種別を選んでください',
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'postback', label: '主催', data: 'action=select_type&type=%E4%B8%BB%E5%82%AC', displayText: '主催' }
        },
        {
          type: 'action',
          action: { type: 'postback', label: '主催以外', data: 'action=select_type&type=%E4%B8%BB%E5%82%AC%E4%BB%A5%E5%A4%96', displayText: '主催以外' }
        }
      ]
    }
  };
}

function buildDatePicker(liveType) {
  const today = todayJST();
  const initDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
  initDate.setMonth(initDate.getMonth() + 1);
  const initial = initDate.toISOString().split('T')[0];

  return {
    type: 'template',
    altText: 'ライブの日付を選んでください',
    template: {
      type: 'buttons',
      text: `📅 ${liveType}ライブの日付を選んでください`,
      actions: [
        {
          type: 'datetimepicker',
          label: '📅 カレンダーで選ぶ',
          data: `action=set_date&type=${encodeURIComponent(liveType)}`,
          mode: 'date',
          initial,
          min: today,
          max: '2030-12-31'
        }
      ]
    }
  };
}

function buildLiveHeader(live, extraText) {
  const title = live.name ? live.name : formatDate(live.date);
  const sub = [formatDate(live.date), live.type, live.venue].filter(Boolean).join('　');
  return [
    { type: 'text', text: title, color: '#ffffff', weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: `${sub}　${extraText}`, color: '#ddffdd', size: 'sm', wrap: true }
  ];
}

function buildTaskFlex(live, tasks) {
  const today = todayJST();
  const doneCount = tasks.filter((t) => t.is_done).length;

  const taskItems = tasks.map((t) => {
    const isOverdue = !t.is_done && t.deadline < today;
    const icon = t.is_done ? '✅' : isOverdue ? '⚠️' : '☐';
    const nameColor = t.is_done ? '#888888' : isOverdue ? '#FF4444' : '#333333';
    const dateColor = isOverdue && !t.is_done ? '#FF4444' : '#aaaaaa';

    return {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      margin: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          contents: [
            { type: 'text', text: `${icon} ${t.name}`, size: 'sm', wrap: true, color: nameColor, decoration: t.is_done ? 'line-through' : 'none' },
            { type: 'text', text: `期限: ${formatDate(t.deadline)}`, size: 'xxs', color: dateColor }
          ]
        },
        t.is_done
          ? { type: 'button', action: { type: 'message', label: '戻す', text: `チェック解除 ${t.id}` }, style: 'secondary', height: 'sm', flex: 0, adjustMode: 'shrink-to-fit' }
          : { type: 'button', action: { type: 'message', label: 'Done', text: `チェック ${t.id}` }, style: 'primary', height: 'sm', color: '#00B900', flex: 0, adjustMode: 'shrink-to-fit' }
      ]
    };
  });

  return {
    type: 'flex',
    altText: `${live.name || formatDate(live.date)}のタスク`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#00B900',
        paddingAll: 'lg',
        contents: buildLiveHeader(live, `完了: ${doneCount}/${tasks.length}件`)
      },
      body: { type: 'box', layout: 'vertical', spacing: 'none', contents: taskItems }
    }
  };
}

function buildLiveCarousel(lives, tasks, today) {
  const bubbles = lives.map((l) => {
    const liveTasks = tasks.filter((t) => t.live_id === l.id);
    const pending = liveTasks.filter((t) => !t.is_done).length;
    const hasOverdue = liveTasks.some((t) => !t.is_done && t.deadline < today);

    return {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: hasOverdue ? '#FF4444' : '#00B900',
        paddingAll: 'lg',
        contents: buildLiveHeader(l, `未完了: ${pending}件${hasOverdue ? ' ⚠️' : ''}`)
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'message', label: '📋 タスクを見る', text: `タスク ${l.id}` }, style: 'primary', color: '#00B900' },
          { type: 'button', action: { type: 'postback', label: '🗑️ このライブを削除', data: `action=confirm_delete&live_id=${l.id}`, displayText: '削除確認' }, style: 'secondary', margin: 'sm' }
        ]
      }
    };
  });

  return { type: 'flex', altText: 'ライブ一覧', contents: { type: 'carousel', contents: bubbles } };
}

// ---- コアハンドラー ----

async function handleAddLive(dateStr, liveType, liveName, liveVenue, userId, reply) {
  const { data: live, error } = await supabase
    .from('lives')
    .insert({ date: dateStr, type: liveType, name: liveName || null, venue: liveVenue || null, user_id: userId })
    .select()
    .single();

  if (error) return reply({ type: 'text', text: '❌ 登録に失敗しました。' });

  const taskDefs = getTasksForLive(dateStr, liveType);
  await supabase.from('tasks').insert(taskDefs.map((t) => ({ live_id: live.id, name: t.name, deadline: t.deadline })));

  const { data: tasks } = await supabase.from('tasks').select('*').eq('live_id', live.id).order('deadline');

  const label = live.name || formatDate(dateStr);
  return reply([
    { type: 'text', text: `✅ 「${label}」を登録しました！` },
    buildTaskFlex(live, tasks || [])
  ]);
}

async function handleAddLiveText(text, userId, reply) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return reply({ type: 'text', text: '❌ 形式: ライブ追加 2026-09-15 主催' });
  const [, dateStr, liveType] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return reply({ type: 'text', text: '❌ 日付形式: 2026-09-15' });
  if (!['主催', '主催以外'].includes(liveType)) return reply({ type: 'text', text: '❌ 種別は「主催」または「主催以外」' });
  return handleAddLive(dateStr, liveType, null, null, userId, reply);
}

async function handleListLives(userId, reply) {
  const today = todayJST();
  const { data: lives } = await supabase.from('lives').select('*').eq('user_id', userId).order('date');

  if (!lives || lives.length === 0) {
    return reply({ type: 'text', text: '📭 登録済みライブはありません。', quickReply: { items: [{ type: 'action', action: { type: 'message', label: '➕ ライブ追加', text: 'ライブ追加' } }] } });
  }

  const { data: tasks } = await supabase.from('tasks').select('*').in('live_id', lives.map((l) => l.id));
  return reply(buildLiveCarousel(lives, tasks || [], today));
}

async function handleShowTasks(liveId, userId, reply) {
  const { data: live } = await supabase.from('lives').select('*').eq('id', liveId).eq('user_id', userId).single();
  if (!live) return reply({ type: 'text', text: '❌ ライブが見つかりません。' });

  const { data: tasks } = await supabase.from('tasks').select('*').eq('live_id', liveId).order('deadline');
  return reply(buildTaskFlex(live, tasks || []));
}

async function handleCheck(taskId, userId, reply) {
  const { data: task } = await supabase
    .from('tasks')
    .select('*, lives!inner(user_id, date, type, name, venue)')
    .eq('id', taskId)
    .eq('lives.user_id', userId)
    .single();

  if (!task) return reply({ type: 'text', text: '❌ タスクが見つかりません。' });
  if (task.is_done) return reply({ type: 'text', text: `✅ 「${task.name}」はすでに完了済みです。` });

  await supabase.from('tasks').update({ is_done: true, last_notified: null }).eq('id', taskId);

  const { data: tasks } = await supabase.from('tasks').select('*').eq('live_id', task.live_id).order('deadline');
  const live = { id: task.live_id, ...task.lives };

  return reply([
    { type: 'text', text: `✅ 「${task.name}」を完了にしました！` },
    buildTaskFlex(live, tasks || [])
  ]);
}

async function handleUncheck(taskId, userId, reply) {
  const { data: task } = await supabase
    .from('tasks')
    .select('*, lives!inner(user_id, date, type, name, venue)')
    .eq('id', taskId)
    .eq('lives.user_id', userId)
    .single();

  if (!task) return reply({ type: 'text', text: '❌ タスクが見つかりません。' });

  await supabase.from('tasks').update({ is_done: false }).eq('id', taskId);

  const { data: tasks } = await supabase.from('tasks').select('*').eq('live_id', task.live_id).order('deadline');
  const live = { id: task.live_id, ...task.lives };

  return reply([
    { type: 'text', text: `↩️ 「${task.name}」の完了を取り消しました。` },
    buildTaskFlex(live, tasks || [])
  ]);
}

async function handleListLivesForDelete(userId, reply) {
  const today = todayJST();
  const { data: lives } = await supabase.from('lives').select('*').eq('user_id', userId).order('date');
  if (!lives || lives.length === 0) return reply({ type: 'text', text: '📭 登録済みライブはありません。' });

  const { data: tasks } = await supabase.from('tasks').select('*').in('live_id', lives.map((l) => l.id));

  const bubbles = lives.map((l) => {
    const liveTasks = (tasks || []).filter((t) => t.live_id === l.id);
    const pending = liveTasks.filter((t) => !t.is_done).length;
    const hasOverdue = liveTasks.some((t) => !t.is_done && t.deadline < today);

    return {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: hasOverdue ? '#FF4444' : '#00B900',
        paddingAll: 'lg',
        contents: buildLiveHeader(l, `未完了: ${pending}件`)
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', action: { type: 'postback', label: '🗑️ このライブを削除', data: `action=confirm_delete&live_id=${l.id}`, displayText: '削除確認' }, style: 'secondary', color: '#FF4444' }
        ]
      }
    };
  });

  return reply({ type: 'flex', altText: '削除するライブを選んでください', contents: { type: 'carousel', contents: bubbles } });
}

async function handleConfirmDelete(liveId, userId, reply) {
  const { data: live } = await supabase.from('lives').select('*').eq('id', liveId).eq('user_id', userId).single();
  if (!live) return reply({ type: 'text', text: '❌ ライブが見つかりません。' });

  const label = live.name || formatDate(live.date);

  return reply({
    type: 'flex',
    altText: '削除の確認',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#FF4444', paddingAll: 'lg', contents: [{ type: 'text', text: '🗑️ 削除の確認', color: '#ffffff', weight: 'bold' }] },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `「${label}」`, wrap: true, weight: 'bold' },
          { type: 'text', text: 'このライブとタスクをすべて削除しますか？', wrap: true, color: '#666666', size: 'sm' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'postback', label: 'キャンセル', data: 'action=cancel', displayText: 'キャンセル' }, style: 'secondary', flex: 1 },
          { type: 'button', action: { type: 'postback', label: '削除する', data: `action=delete_live&live_id=${liveId}`, displayText: '削除しました' }, style: 'primary', color: '#FF4444', flex: 1 }
        ]
      }
    }
  });
}

async function handleDeleteLive(liveId, userId, reply) {
  const { data: live } = await supabase.from('lives').select('*').eq('id', liveId).eq('user_id', userId).single();
  if (!live) return reply({ type: 'text', text: '❌ ライブが見つかりません。' });

  await supabase.from('lives').delete().eq('id', liveId);
  const label = live.name || formatDate(live.date);
  return reply({ type: 'text', text: `🗑️ 「${label}」を削除しました。` });
}

function helpText() {
  return `🎵 バンドライブToDo

「メニュー」→ ボタン一覧を表示
「ライブ追加」→ 種別・日付・ライブ名・場所を順番に入力
「ライブ一覧」→ カードで一覧表示・タスク確認
「ライブ削除」→ 削除したいライブを選択・確認後に削除
カードの「タスクを見る」→ 各タスクにDoneボタン

⚠️ 期限切れ未完了タスクは2日ごとに通知`;
}

module.exports = { handleMessage, handlePostback };
