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

// どのチャットから操作しても共通のIDでデータを共有する
function sharedId(chatId) {
  return process.env.CALENDAR_CHAT_ID || chatId;
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
  const userId = getChatId(event.source);
  const replyToken = event.replyToken;
  const reply = (messages) =>
    client.replyMessage({ replyToken, messages: Array.isArray(messages) ? messages : [messages] });

  // 画像メッセージ：awaiting_flyerセッション中なら画像をアップロード
  if (event.message.type === 'image') {
    const session = await getSession(userId);
    if (session && session.step === 'awaiting_flyer') {
      let flyerUrl = null;
      try {
        const stream = await client.getMessageContent(event.message.id);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const filename = `${Date.now()}.jpg`;
        const { error } = await supabase.storage.from('flyers').upload(filename, buffer, { contentType: 'image/jpeg', upsert: true });
        if (!error) {
          const { data: { publicUrl } } = supabase.storage.from('flyers').getPublicUrl(filename);
          flyerUrl = publicUrl;
        }
      } catch (e) {
        console.error('フライヤー画像アップロード失敗:', e.message);
      }
      await setSession(userId, 'awaiting_notes', { ...session.data, flyer_url: flyerUrl });
      return reply({
        type: 'text',
        text: flyerUrl ? '✅ 画像を保存しました！\n📌 その他メモを入力してください（任意）' : '⚠️ 画像の保存に失敗しました。\n📌 その他メモを入力してください（任意）',
        quickReply: { items: [{ type: 'action', action: { type: 'message', label: 'スキップ', text: 'スキップ' } }] }
      });
    }
    return;
  }

  if (event.message.type !== 'text') return;
  const text = event.message.text.trim();

  // セッション中の入力を最優先で処理
  const session = await getSession(userId);
  if (session) {
    if (text === 'キャンセル') {
      await clearSession(userId);
      return reply({ type: 'text', text: 'キャンセルしました。' });
    }
    return handleSessionInput(session, text, userId, reply);
  }

  if (text === 'メニュー' || text === 'menu')            return reply(buildMenu());
  if (text === 'ライブ追加' || text === '追加')          return reply(buildTypeSelection());
  if (text === 'ライブ一覧' || text === '一覧')          return handleListLives(userId, reply);
  if (text === 'ライブ削除' || text === '削除')          return handleListLivesForDelete(userId, reply);
  if (text === '予定追加')                               return handleStartAddEvent(userId, reply);
  if (text === '予定一覧')                               return handleListEvents(userId, reply);
  if (/^タスク \d+$/.test(text))                         return handleShowTasks(parseInt(text.split(' ')[1]), userId, reply);
  if (/^チェック解除 \d+$/.test(text))                   return handleUncheck(parseInt(text.split(' ')[1]), userId, reply);
  if (/^チェック \d+$/.test(text))                       return handleCheck(parseInt(text.split(' ')[1]), userId, reply);
  if (text === 'ヘルプ' || text === 'help')              return reply({ type: 'text', text: helpText() });
  if (text === 'ID確認')                                 return reply({ type: 'text', text: `このチャットのID:\n${userId}` });
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
    await setSession(chatId, 'awaiting_description', { ...session.data, venue });
    return reply({
      type: 'text',
      text: '📝 詳細を入力してください（任意）\n例：出演時間、セット時間など',
      quickReply: {
        items: [{ type: 'action', action: { type: 'message', label: 'スキップ', text: 'スキップ' } }]
      }
    });
  }

  if (session.step === 'awaiting_description') {
    const description = isSkip ? null : text;
    await setSession(chatId, 'awaiting_flyer', { ...session.data, description });
    return reply({
      type: 'text',
      text: '🖼️ フライヤー画像URLを入力してください（任意）',
      quickReply: {
        items: [{ type: 'action', action: { type: 'message', label: 'スキップ', text: 'スキップ' } }]
      }
    });
  }

  if (session.step === 'awaiting_flyer') {
    const flyer_url = isSkip ? null : text;
    await setSession(chatId, 'awaiting_notes', { ...session.data, flyer_url });
    return reply({
      type: 'text',
      text: '📌 その他メモを入力してください（任意）\n例：物販準備、集合時間など',
      quickReply: {
        items: [{ type: 'action', action: { type: 'message', label: 'スキップ', text: 'スキップ' } }]
      }
    });
  }

  if (session.step === 'awaiting_notes') {
    const notes = isSkip ? null : text;
    const { date, type, name, venue, description, flyer_url } = session.data;
    await clearSession(chatId);
    return handleAddLive(date, type, name, venue, description, flyer_url, notes, null, chatId, reply);
  }

  if (session.step === 'event_title') {
    await setSession(chatId, 'event_date', { title: text });
    return reply(buildEventDatePicker());
  }

  if (session.step === 'event_location') {
    const location = isSkip ? null : text;
    const { title, date } = session.data;
    await clearSession(chatId);
    return handleAddEvent(title, date, location, chatId, reply);
  }

  if (session.step === 'editing_name') {
    const { live_id } = session.data;
    const newName = (isSkip || text === 'クリア') ? null : text;
    await clearSession(chatId);
    return handleUpdateLiveField(live_id, { name: newName }, chatId, reply);
  }

  if (session.step === 'editing_venue') {
    const { live_id } = session.data;
    const newVenue = (isSkip || text === 'クリア') ? null : text;
    await clearSession(chatId);
    return handleUpdateLiveField(live_id, { venue: newVenue }, chatId, reply);
  }

  if (session.step === 'editing_description') {
    const { live_id } = session.data;
    const newVal = (isSkip || text === 'クリア') ? null : text;
    await clearSession(chatId);
    return handleUpdateLiveField(live_id, { description: newVal }, chatId, reply);
  }

  if (session.step === 'editing_flyer') {
    const { live_id } = session.data;
    const newVal = (isSkip || text === 'クリア') ? null : text;
    await clearSession(chatId);
    return handleUpdateLiveField(live_id, { flyer_url: newVal }, chatId, reply);
  }

  if (session.step === 'editing_notes') {
    const { live_id } = session.data;
    const newVal = (isSkip || text === 'クリア') ? null : text;
    await clearSession(chatId);
    return handleUpdateLiveField(live_id, { notes: newVal }, chatId, reply);
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

  if (action === 'edit_live') {
    const liveId = parseInt(params.get('live_id'));
    return handleEditLive(liveId, userId, reply);
  }

  if (action === 'edit_date') {
    const liveId = parseInt(params.get('live_id'));
    return reply(buildDatePickerForEdit(liveId));
  }

  if (action === 'set_edit_date') {
    const liveId = parseInt(params.get('live_id'));
    const dateStr = event.postback.params.date;
    return handleUpdateLiveField(liveId, { date: dateStr }, userId, reply);
  }

  if (action === 'edit_name') {
    const liveId = parseInt(params.get('live_id'));
    await setSession(userId, 'editing_name', { live_id: liveId });
    return reply({ type: 'text', text: '🎤 新しいライブ名を入力してください\n（「クリア」で削除）', quickReply: { items: [{ type: 'action', action: { type: 'message', label: 'クリア', text: 'クリア' } }, { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }] } });
  }

  if (action === 'edit_venue') {
    const liveId = parseInt(params.get('live_id'));
    await setSession(userId, 'editing_venue', { live_id: liveId });
    return reply({ type: 'text', text: '📍 新しい場所を入力してください\n（「クリア」で削除）', quickReply: { items: [{ type: 'action', action: { type: 'message', label: 'クリア', text: 'クリア' } }, { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }] } });
  }

  if (action === 'edit_description') {
    const liveId = parseInt(params.get('live_id'));
    await setSession(userId, 'editing_description', { live_id: liveId });
    return reply({ type: 'text', text: '📝 新しい詳細を入力してください\n（「クリア」で削除）', quickReply: { items: [{ type: 'action', action: { type: 'message', label: 'クリア', text: 'クリア' } }, { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }] } });
  }

  if (action === 'edit_flyer') {
    const liveId = parseInt(params.get('live_id'));
    await setSession(userId, 'editing_flyer', { live_id: liveId });
    return reply({ type: 'text', text: '🖼️ フライヤー画像URLを入力してください\n（「クリア」で削除）', quickReply: { items: [{ type: 'action', action: { type: 'message', label: 'クリア', text: 'クリア' } }, { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }] } });
  }

  if (action === 'edit_notes') {
    const liveId = parseInt(params.get('live_id'));
    await setSession(userId, 'editing_notes', { live_id: liveId });
    return reply({ type: 'text', text: '📌 その他メモを入力してください\n（「クリア」で削除）', quickReply: { items: [{ type: 'action', action: { type: 'message', label: 'クリア', text: 'クリア' } }, { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }] } });
  }

  if (action === 'set_event_date') {
    const dateStr = event.postback.params.date;
    const session = await getSession(userId);
    if (!session || session.step !== 'event_date') {
      return reply({ type: 'text', text: '❌ もう一度「予定追加」から始めてください。' });
    }
    await setSession(userId, 'event_location', { title: session.data.title, date: dateStr });
    return reply({
      type: 'text',
      text: `📅 ${formatDate(dateStr)}\n\n📍 場所を入力してください（任意）`,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: 'スキップ', text: 'スキップ' } },
          { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }
        ]
      }
    });
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
  const makeBtn = (label, text, color) => ({
    type: 'button',
    action: { type: 'message', label, text },
    style: 'primary',
    color
  });
  const separator = (title) => ({
    type: 'text', text: title, size: 'xs', color: '#aaaaaa', margin: 'md'
  });

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
        contents: [
          separator('── ライブ ──'),
          makeBtn('➕ ライブ追加', 'ライブ追加', '#00B900'),
          makeBtn('📋 ライブ一覧', 'ライブ一覧', '#00B900'),
          makeBtn('🗑️ ライブ削除', 'ライブ削除', '#888888'),
          separator('── 予定 ──'),
          makeBtn('➕ 予定追加',   '予定追加',   '#4A90D9'),
          makeBtn('📋 予定一覧',   '予定一覧',   '#4A90D9'),
          separator('── その他 ──'),
          makeBtn('❓ ヘルプ',     'ヘルプ',     '#888888'),
        ]
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

  const bodyContents = [];
  if (live.description) {
    bodyContents.push({ type: 'box', layout: 'vertical', backgroundColor: '#f5f5f5', cornerRadius: 'sm', paddingAll: 'sm', margin: 'md', contents: [{ type: 'text', text: `📝 ${live.description}`, size: 'sm', color: '#666666', wrap: true }] });
  }
  if (live.setlist) {
    const songs = live.setlist.split(',').map((s, i) => `${i + 1}. ${s.trim()}`).join('\n');
    bodyContents.push({ type: 'box', layout: 'vertical', backgroundColor: '#f0f8ff', cornerRadius: 'sm', paddingAll: 'sm', margin: 'md', contents: [{ type: 'text', text: '🎵 セトリ', size: 'xs', color: '#4A90D9', weight: 'bold' }, { type: 'text', text: songs, size: 'sm', color: '#333333', wrap: true, margin: 'sm' }] });
  }
  if (live.notes) {
    bodyContents.push({ type: 'text', text: `📌 ${live.notes}`, size: 'sm', color: '#666666', wrap: true, margin: 'md' });
  }
  bodyContents.push(...taskItems);
  if (live.flyer_url) {
    bodyContents.push({ type: 'button', action: { type: 'uri', label: '🖼️ フライヤーを見る', uri: live.flyer_url }, style: 'secondary', margin: 'lg' });
  }

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
      body: { type: 'box', layout: 'vertical', spacing: 'none', contents: bodyContents }
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
          { type: 'button', action: { type: 'postback', label: '✏️ ライブを編集', data: `action=edit_live&live_id=${l.id}`, displayText: 'ライブを編集' }, style: 'secondary', margin: 'sm' },
          { type: 'button', action: { type: 'postback', label: '🗑️ このライブを削除', data: `action=confirm_delete&live_id=${l.id}`, displayText: '削除確認' }, style: 'secondary', margin: 'sm' }
        ]
      }
    };
  });

  return { type: 'flex', altText: 'ライブ一覧', contents: { type: 'carousel', contents: bubbles } };
}

function buildEventDatePicker() {
  const today = todayJST();
  return {
    type: 'template',
    altText: '予定の日付を選んでください',
    template: {
      type: 'buttons',
      text: '📅 予定の日付を選んでください',
      actions: [{
        type: 'datetimepicker',
        label: '📅 カレンダーで選ぶ',
        data: 'action=set_event_date',
        mode: 'date',
        initial: today,
        min: '2020-01-01',
        max: '2030-12-31'
      }]
    }
  };
}

function buildDatePickerForEdit(liveId) {
  const today = todayJST();
  return {
    type: 'template',
    altText: '新しい日付を選んでください',
    template: {
      type: 'buttons',
      text: '📅 新しいライブ日付を選んでください',
      actions: [
        {
          type: 'datetimepicker',
          label: '📅 カレンダーで選ぶ',
          data: `action=set_edit_date&live_id=${liveId}`,
          mode: 'date',
          initial: today,
          min: '2020-01-01',
          max: '2030-12-31'
        }
      ]
    }
  };
}

function buildEditMenu(live) {
  const label = live.name || formatDate(live.date);
  const pb = (lbl, act) => ({ type: 'button', action: { type: 'postback', label: lbl, data: `action=${act}&live_id=${live.id}`, displayText: lbl }, style: 'secondary', margin: 'sm' });
  return {
    type: 'flex',
    altText: 'ライブを編集',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#4A90D9', paddingAll: 'lg',
        contents: [
          { type: 'text', text: '✏️ ライブを編集', color: '#ffffff', weight: 'bold', size: 'lg' },
          { type: 'text', text: label, color: '#ddeeff', size: 'sm', wrap: true }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'postback', label: '📅 日付を変更', data: `action=edit_date&live_id=${live.id}`, displayText: '日付を変更' }, style: 'primary', color: '#4A90D9' },
          pb('🎤 ライブ名を変更', 'edit_name'),
          pb('📍 場所を変更',     'edit_venue'),
          pb('📝 詳細を変更',     'edit_description'),
          pb('🖼️ フライヤーURLを変更', 'edit_flyer'),
          pb('📌 その他メモを変更',   'edit_notes'),
        ]
      }
    }
  };
}

// ---- コアハンドラー ----

async function handleAddLive(dateStr, liveType, liveName, liveVenue, description, flyerUrl, notes, setlist, userId, reply) {
  const { data: live, error } = await supabase
    .from('lives')
    .insert({ date: dateStr, type: liveType, name: liveName || null, venue: liveVenue || null, description: description || null, flyer_url: flyerUrl || null, notes: notes || null, setlist: setlist || null, user_id: sharedId(userId) })
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
  return handleAddLive(dateStr, liveType, null, null, null, null, null, null, userId, reply);
}

async function handleListLives(userId, reply) {
  const today = todayJST();

  // 今日以降のライブを最大5件取得（LINEの返信メッセージ上限）
  const { data: upcoming } = await supabase
    .from('lives').select('*').eq('user_id', sharedId(userId))
    .gte('date', today).order('date').limit(5);

  // 0件の場合は直近の過去ライブを最大5件表示
  const lives = (upcoming && upcoming.length > 0)
    ? upcoming
    : (await supabase.from('lives').select('*').eq('user_id', sharedId(userId))
        .lt('date', today).order('date', { ascending: false }).limit(5)).data;

  if (!lives || lives.length === 0) {
    return reply({ type: 'text', text: '📭 登録済みライブはありません。', quickReply: { items: [{ type: 'action', action: { type: 'message', label: '➕ ライブ追加', text: 'ライブ追加' } }] } });
  }

  const { data: tasks } = await supabase.from('tasks').select('*').in('live_id', lives.map((l) => l.id)).order('deadline');
  const bubbles = lives.map((l) => buildTaskFlex(l, (tasks || []).filter((t) => t.live_id === l.id)).contents);
  return reply({
    type: 'flex',
    altText: `ライブ一覧（${lives.length}件）`,
    contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles }
  });
}

async function handleShowTasks(liveId, userId, reply) {
  const { data: live } = await supabase.from('lives').select('*').eq('id', liveId).eq('user_id', sharedId(userId)).single();
  if (!live) return reply({ type: 'text', text: '❌ ライブが見つかりません。' });

  const { data: tasks } = await supabase.from('tasks').select('*').eq('live_id', liveId).order('deadline');
  return reply(buildTaskFlex(live, tasks || []));
}

async function handleCheck(taskId, userId, reply) {
  const { data: task } = await supabase
    .from('tasks')
    .select('*, lives!inner(user_id, date, type, name, venue, description, flyer_url, setlist, notes)')
    .eq('id', taskId)
    .eq('lives.user_id', sharedId(userId))
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
    .select('*, lives!inner(user_id, date, type, name, venue, description, flyer_url, setlist, notes)')
    .eq('id', taskId)
    .eq('lives.user_id', sharedId(userId))
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

async function handleEditLive(liveId, userId, reply) {
  const { data: live } = await supabase.from('lives').select('*').eq('id', liveId).eq('user_id', sharedId(userId)).single();
  if (!live) return reply({ type: 'text', text: '❌ ライブが見つかりません。' });
  return reply(buildEditMenu(live));
}

async function handleUpdateLiveField(liveId, fields, userId, reply) {
  const { data: live, error } = await supabase
    .from('lives')
    .update(fields)
    .eq('id', liveId)
    .eq('user_id', sharedId(userId))
    .select()
    .single();

  if (error || !live) return reply({ type: 'text', text: '❌ 更新に失敗しました。' });

  const label = live.name || formatDate(live.date);
  const fieldLabel = fields.date ? '日付' : fields.name !== undefined ? 'ライブ名' : fields.venue !== undefined ? '場所' : fields.description !== undefined ? '詳細' : 'フライヤー';
  return reply({ type: 'text', text: `✅ 「${label}」の${fieldLabel}を更新しました！` });
}

async function handleStartAddEvent(userId, reply) {
  await setSession(userId, 'event_title', {});
  return reply({ type: 'text', text: '📝 予定のタイトルを入力してください' });
}

async function handleAddEvent(title, dateStr, location, userId, reply) {
  const { error } = await supabase
    .from('events')
    .insert({ title, date: dateStr, location: location || null, user_id: sharedId(userId) });

  if (error) return reply({ type: 'text', text: '❌ 登録に失敗しました。' });

  let text = `✅ 予定を登録しました！\n\n📅 ${formatDate(dateStr)}\n🗓️ ${title}`;
  if (location) text += `\n📍 ${location}`;
  return reply({ type: 'text', text });
}

async function handleListEvents(userId, reply) {
  const today = todayJST();
  const { data: events } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', sharedId(userId))
    .gte('date', today)
    .order('date')
    .limit(10);

  if (!events || events.length === 0) {
    return reply({ type: 'text', text: '📭 今後の予定はありません。\n「予定追加」で登録できます。' });
  }

  let text = `📅 今後の予定（${events.length}件）\n\n`;
  for (const ev of events) {
    text += `${formatDate(ev.date)}　${ev.title}`;
    if (ev.location) text += `\n　📍 ${ev.location}`;
    text += '\n\n';
  }
  return reply({ type: 'text', text: text.trim() });
}

async function handleListLivesForDelete(userId, reply) {
  const today = todayJST();
  const { data: lives } = await supabase.from('lives').select('*').eq('user_id', sharedId(userId)).order('date').limit(10);
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
  const { data: live } = await supabase.from('lives').select('*').eq('id', liveId).eq('user_id', sharedId(userId)).single();
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
  const { data: live } = await supabase.from('lives').select('*').eq('id', liveId).eq('user_id', sharedId(userId)).single();
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
