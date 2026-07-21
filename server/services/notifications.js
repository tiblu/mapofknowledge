const db = require('../db');

async function getUserLocale(userId) {
  if (!userId) return 'en';
  try {
    const [rows] = await db.execute(
      'SELECT value FROM user_settings WHERE user_id = ? AND key_name = ?',
      [userId, 'ui_locale']
    );
    return (rows.length && rows[0].value) ? rows[0].value : 'et';
  } catch { return 'en'; }
}

const TYPE_COLOR = {
  welcome:          'terra',
  knobit_complete:  'sage',
  unit_complete:    'amber',
  credential:       'amber',
  test_result:      'lavender',
  goal_complete:    'sage',
  goal_assigned:    'terra',
  knowledge_marked: 'terra',
  admin:            'lavender',
  badge:            'amber',
  streak:           'amber',
  achievement:      'amber',
};

async function notify(userId, type, title, body, nodeExternalId = null) {
  if (!userId) return;
  const iconColor = TYPE_COLOR[type] || 'terra';
  try {
    await db.execute(
      `INSERT INTO notifications (user_id, type, title, body, icon_color, node_external_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, type, title, body || null, iconColor, nodeExternalId]
    );
  } catch (err) {
    console.error('[notifications]', err.message);
  }
}

module.exports = { notify, getUserLocale };
