/**
 * Commands.gs
 * Discord Slash Command をギルドに一括登録するためのユーティリティ。
 * GASエディタから registerSlashCommands() を一度実行する。
 *
 * 事前に Discord Developer Portal の General Information から
 * Interactions Endpoint URL に Web App の /exec URL を設定しておくこと。
 */

function registerSlashCommands() {
  const appId = Config.discordClientId();
  const guildId = Config.discordGuildId();
  const token = Config.discordBotToken();
  if (!appId || !guildId || !token) {
    throw new Error('DISCORD_CLIENT_ID / DISCORD_GUILD_ID / DISCORD_BOT_TOKEN を設定してください。');
  }

  const SUB = 1;      // SUB_COMMAND
  const STRING = 3;   // STRING option
  const USER = 6;     // USER option

  const titleOpt = { type: STRING, name: 'title', description: '本のタイトル', required: true };
  const kwOpt = { type: STRING, name: 'キーワード', description: '検索キーワード', required: true };

  const commands = [
    {
      name: 'book', description: '蔵書の閲覧・検索',
      options: [
        { type: SUB, name: 'list', description: '空き本の一覧' },
        { type: SUB, name: 'search', description: 'タイトル・タグで検索', options: [kwOpt] },
        { type: SUB, name: 'info', description: '本の詳細', options: [titleOpt] },
      ],
    },
    {
      name: 'lend', description: '貸出・返却・延長',
      options: [
        { type: SUB, name: 'request', description: '貸出申請', options: [titleOpt] },
        { type: SUB, name: 'return', description: '返却報告', options: [titleOpt] },
        { type: SUB, name: 'extend', description: '延長申請', options: [titleOpt] },
      ],
    },
    {
      name: 'waitlist', description: '待ちリスト',
      options: [{ type: SUB, name: 'join', description: '待ちリスト登録', options: [titleOpt] }],
    },
    { name: 'review', description: 'レビュー投稿', options: [titleOpt] },
    {
      name: 'request', description: '購入リクエスト',
      options: [
        { type: SUB, name: 'add', description: 'リクエスト投稿', options: [
          { type: STRING, name: 'title', description: 'タイトル', required: true },
          { type: STRING, name: 'reason', description: '読みたい理由', required: false },
        ] },
        { type: SUB, name: 'list', description: 'リクエスト一覧' },
        { type: SUB, name: 'vote', description: 'リクエストに+1', options: [titleOpt] },
      ],
    },
    { name: 'mypage', description: '自分の借り中・読了・バッジ' },
    {
      name: 'baton', description: 'バトンリレー指名',
      options: [titleOpt, { type: USER, name: 'member', description: '指名する部員', required: true }],
    },
  ];

  const url = 'https://discord.com/api/v10/applications/' + appId + '/guilds/' + guildId + '/commands';
  const res = UrlFetchApp.fetch(url, {
    method: 'put', // 一括上書き登録
    contentType: 'application/json',
    headers: { Authorization: 'Bot ' + token },
    payload: JSON.stringify(commands),
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + ': ' + res.getContentText());
  if (res.getResponseCode() >= 300) throw new Error('登録に失敗: ' + res.getContentText());
  return 'Slash Commands を登録しました。';
}
