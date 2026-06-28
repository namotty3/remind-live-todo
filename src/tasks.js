const TASK_DEFINITIONS = {
  主催: [
    { name: '対バンを呼ぶ',    monthsBefore: 6 },
    { name: 'タイテ作成',      monthsBefore: 5 },
    { name: 'フライヤー作成',  monthsBefore: 5 },
    { name: 'サポート確定',    monthsBefore: 1 },
    { name: 'セトリ作成',      monthsBefore: 1 },
    { name: 'セット図作成',    weeksBefore:  2 },
  ],
  主催以外: [
    { name: 'サポート確定',    monthsBefore: 1 },
    { name: 'セトリ作成',      monthsBefore: 1 },
    { name: 'セット図作成',    weeksBefore:  2 },
  ],
};

function calcDeadline(liveDateStr, task) {
  const [y, m, d] = liveDateStr.split('-').map(Number);
  let year = y, month = m, day = d;

  if (task.monthsBefore) {
    month -= task.monthsBefore;
    while (month <= 0) { month += 12; year -= 1; }
  } else if (task.weeksBefore) {
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() - task.weeksBefore * 7);
    return date.toISOString().split('T')[0];
  }

  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function getTasksForLive(liveDateStr, liveType) {
  const defs = TASK_DEFINITIONS[liveType];
  if (!defs) return [];
  return defs.map((def) => ({
    name: def.name,
    deadline: calcDeadline(liveDateStr, def),
  }));
}

module.exports = { getTasksForLive };
