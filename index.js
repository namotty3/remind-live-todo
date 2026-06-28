require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { handleMessage, handlePostback } = require('./src/lineHandler');
const { initScheduler } = require('./src/scheduler');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

console.log('Channel Secret 設定済み:', !!lineConfig.channelSecret);
console.log('Access Token 設定済み:', !!lineConfig.channelAccessToken);

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

const app = express();

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const results = await Promise.allSettled(
    req.body.events.map((event) => {
      if (event.type === 'message' && event.message.type === 'text') {
        return handleMessage(event, client);
      }
      if (event.type === 'postback') {
        return handlePostback(event, client);
      }
    })
  );

  results.forEach((r) => {
    if (r.status === 'rejected') console.error('エラー:', r.reason);
  });

  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error('Webhookエラー:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.get('/', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動 → http://localhost:${PORT}`);
  initScheduler(client);
});
