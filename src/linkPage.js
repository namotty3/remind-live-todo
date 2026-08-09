const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const supabase = require('./database');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'link-page.html');

async function fetchPublicLives() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('lives')
    .select('date, type, name, venue, description, stage_time, flyer_url, taiban')
    .eq('is_public', true)
    .gte('date', today)
    .order('date');
  if (error) throw new Error(`ライブ情報の取得に失敗: ${error.message}`);
  return data || [];
}

async function toDataUri(url, maxWidth, quality) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`フライヤー画像の取得に失敗: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const resized = await sharp(buf)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString('base64')}`;
}

async function buildLivesData() {
  const lives = await fetchPublicLives();
  const result = [];
  for (const live of lives) {
    const entry = {
      date: live.date,
      type: live.type,
      name: live.name,
      venue: live.venue,
      taiban: live.taiban,
      stage_time: live.stage_time,
      description: live.description,
      flyer_url: null,
      flyer_url_large: null,
    };
    if (live.flyer_url) {
      try {
        entry.flyer_url = await toDataUri(live.flyer_url, 240, 78);
        entry.flyer_url_large = await toDataUri(live.flyer_url, 720, 82);
      } catch (e) {
        console.error('[linkPage] フライヤー埋め込み失敗:', e.message);
      }
    }
    result.push(entry);
  }
  return result;
}

async function generateHtml() {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const lives = await buildLivesData();
  const json = JSON.stringify(lives).replace(/<\/script/gi, '<\\/script');
  if (!template.includes('__LIVES_JSON__')) {
    throw new Error('テンプレートにプレースホルダーが見つかりません');
  }
  return template.replace('__LIVES_JSON__', json);
}

async function publishToGitHub(html) {
  const token = process.env.LINKPAGE_GITHUB_TOKEN;
  const repo = process.env.LINKPAGE_GITHUB_REPO;
  const branch = process.env.LINKPAGE_GITHUB_BRANCH || 'main';
  const filePath = process.env.LINKPAGE_FILE_PATH || 'index.html';

  if (!token || !repo) {
    throw new Error('LINKPAGE_GITHUB_TOKEN / LINKPAGE_GITHUB_REPO が設定されていません');
  }

  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'band-live-todo-linkpage',
  };

  let sha;
  const getRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
  if (getRes.ok) {
    sha = (await getRes.json()).sha;
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub取得エラー: ${getRes.status}`);
  }

  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Update link page (${new Date().toISOString()})`,
      content: Buffer.from(html, 'utf8').toString('base64'),
      branch,
      sha,
    }),
  });

  if (!putRes.ok) {
    const errBody = await putRes.text();
    throw new Error(`GitHub更新エラー: ${putRes.status} ${errBody}`);
  }
}

async function updateLinkPage() {
  const html = await generateHtml();
  await publishToGitHub(html);
  return process.env.LINKPAGE_PUBLIC_URL || null;
}

module.exports = { updateLinkPage };
