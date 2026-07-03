require('dotenv').config();
const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');
const { handleMessage, handlePostback } = require('./src/lineHandler');
const { initScheduler } = require('./src/scheduler');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

console.log('Channel Secret 設定済み:', !!lineConfig.channelSecret);
console.log('Access Token 設定済み:', !!lineConfig.channelAccessToken);

const { client } = require('./src/lineClient');

const app = express();

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', express.json(), require('./src/api'));
app.use('/logo', express.static(path.join(__dirname, 'logo')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/calendar', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  // LINE の replyToken は30秒で失効するため、即座に200を返してから処理する
  res.json({ ok: true });

  Promise.allSettled(
    req.body.events.map((event) => {
      if (event.type === 'message')  return handleMessage(event, client);
      if (event.type === 'postback') return handlePostback(event, client);
    })
  ).then((results) => {
    results.forEach((r) => {
      if (r.status === 'rejected') console.error('イベント処理エラー:', r.reason);
    });
  });
});

app.use((err, _req, res, _next) => {
  console.error('Webhookエラー:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.get('/', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動 → http://localhost:${PORT}`);
  initScheduler();
});
