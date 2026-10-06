// lives.setlist / videos.setlist はカンマ区切りの曲名文字列。
// 同期ありの曲は "曲名::1" の形式でエンコードされる（詳細はpublic/index.htmlのslParse/slSerializeを参照）。
function parseSetlist(raw) {
  const list = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  return list.map(entry => {
    if (entry.endsWith('::1')) return { name: entry.slice(0, -3), sync: true };
    if (entry.endsWith('::0')) return { name: entry.slice(0, -3), sync: false };
    return { name: entry, sync: false };
  });
}

function formatSetlistLines(raw) {
  return parseSetlist(raw).map((e, i) => `${i + 1}. ${e.name}${e.sync ? '（同期あり）' : ''}`);
}

module.exports = { parseSetlist, formatSetlistLines };
