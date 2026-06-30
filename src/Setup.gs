/**
 * Setup.gs
 * 初期セットアップ用。GASエディタから setup() を一度実行すると、
 * Schema 定義に従って全シートを作成し、初期タグ・初期バッジを投入する。
 */

function setup() {
  const ss = SheetDB.ss();

  // 各シートを作成し、ヘッダー行を整える
  Object.keys(Schema).forEach(function (name) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    const cols = Schema[name];
    const headerRange = sheet.getRange(1, 1, 1, cols.length);
    headerRange.setValues([cols]);
    headerRange.setFontWeight('bold').setBackground('#e0eaff');
    sheet.setFrozenRows(1);
  });

  // デフォルトの "シート1" が残っていたら削除
  const def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) {
    try { ss.deleteSheet(def); } catch (e) { /* ignore */ }
  }

  seedTags();
  seedBadges();
  seedAdmins();

  Logger.log('セットアップ完了。Spreadsheet: ' + ss.getUrl());
  return 'OK';
}

/** 初期タグ（仕様書の初期タグ例） */
function seedTags() {
  if (SheetDB.read('tags').length > 0) return;
  const initial = [
    '起業', 'マーケ', '技術', '思想', '組織', 'ファイナンス', '営業', 'デザイン',
    'アイデア期', '開発中', 'PMF', '営業中', '資金調達', 'スケール期',
    '通読向け', 'ななめ読みOK', '辞書的に使う', '課題図書',
    '入門', '中級', '上級',
    '1日で読める', '1週間目安', 'じっくり系',
  ];
  initial.forEach(function (name) {
    SheetDB.insert('tags', {
      tag_id: Utils.uuid(),
      name: name,
      created_by: 'system',
      created_at: Utils.now(),
    });
  });
}

/** 初期バッジ（仕様書の読書バッジ） */
function seedBadges() {
  if (SheetDB.read('badges').length > 0) return;
  const badges = [
    ['初借り', '初めて本を借りる'],
    ['初レビュー', '初めてレビューを書く'],
    ['タグ職人', 'タグを5個以上新規作成する'],
    ['バトンの達人', 'バトンリレーを5回以上実施'],
    ['蔵書貢献者', '部の蔵書に3冊以上登録'],
    ['リクエスター', '購入リクエストが購入済みになる'],
    ['皆勤返却', '遅延ゼロで10冊返却'],
    ['読書会常連', '読書会スレッドに10回以上投稿'],
    ['読破王', '読了マークを20冊以上つける'],
  ];
  badges.forEach(function (b) {
    SheetDB.insert('badges', {
      badge_id: b[0],            // 安定したキーとして名前ベースのIDを使う
      name: b[0],
      condition: b[1],
    });
  });
}

/** ADMIN_DISCORD_IDS に列挙された Discord ID を管理者として members に登録 */
function seedAdmins() {
  const ids = Config.adminDiscordIds();
  ids.forEach(function (discordId) {
    const existing = SheetDB.find('members', function (m) { return m.discord_id === discordId; });
    if (existing) {
      if (existing.role !== 'admin') {
        SheetDB.update('members', 'member_id', existing.member_id, { role: 'admin' });
      }
      return;
    }
    SheetDB.insert('members', {
      member_id: Utils.uuid(),
      discord_id: discordId,
      discord_username: '(管理者)',
      avatar_url: '',
      role: 'admin',
      penalty_until: '',
      penalty_count: 0,
      last_penalty_at: '',
      joined_at: Utils.now(),
    });
  });
}
