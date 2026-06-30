/**
 * Config.gs
 * スクリプトプロパティから設定値を読み出す薄いラッパー。
 *
 * 必要なスクリプトプロパティ（GASエディタ → プロジェクトの設定 → スクリプトプロパティ）:
 *   SPREADSHEET_ID       … DBに使うスプレッドシートのID
 *   DISCORD_CLIENT_ID    … Discord アプリの Client ID
 *   DISCORD_CLIENT_SECRET… Discord アプリの Client Secret
 *   DISCORD_BOT_TOKEN    … Discord Bot トークン（DM/チャンネル通知・メンバー確認用）
 *   DISCORD_GUILD_ID     … 起業部 Discord サーバー（ギルド）ID
 *   DISCORD_PUBLIC_KEY   … Slash Command 署名検証用の公開鍵（任意）
 *   NOTIFY_CHANNEL_ID    … 部内お知らせチャンネルのID（遅延・投票の全体通知用）
 *   GOOGLE_BOOKS_API_KEY … Google Books API キー（任意・無くても動く）
 *   ADMIN_DISCORD_IDS    … 初期管理者の Discord ID（カンマ区切り・任意）
 *   WEBAPP_URL           … デプロイした Web App の /exec URL（OAuthリダイレクト用）
 */

const Config = (function () {
  const props = PropertiesService.getScriptProperties();

  function get(key, fallback) {
    const v = props.getProperty(key);
    return (v === null || v === undefined || v === '') ? (fallback || '') : v;
  }

  return {
    get: get,
    spreadsheetId:      function () { return get('SPREADSHEET_ID'); },
    discordClientId:    function () { return get('DISCORD_CLIENT_ID'); },
    discordClientSecret:function () { return get('DISCORD_CLIENT_SECRET'); },
    discordBotToken:    function () { return get('DISCORD_BOT_TOKEN'); },
    discordGuildId:     function () { return get('DISCORD_GUILD_ID'); },
    discordPublicKey:   function () { return get('DISCORD_PUBLIC_KEY'); },
    notifyChannelId:    function () { return get('NOTIFY_CHANNEL_ID'); },
    googleBooksApiKey:  function () { return get('GOOGLE_BOOKS_API_KEY'); },
    webappUrl:          function () { return get('WEBAPP_URL') || ScriptApp.getService().getUrl(); },
    adminDiscordIds:    function () {
      return get('ADMIN_DISCORD_IDS').split(',').map(function (s) { return s.trim(); }).filter(String);
    },
  };
})();

// 貸出期間・ペナルティ等のビジネスルール定数
const Rules = {
  DEFAULT_LEND_DAYS: 14,        // 標準貸与期間
  LONG_BOOK_LEND_DAYS: 28,      // 300ページ以上
  LONG_BOOK_PAGE_THRESHOLD: 300,
  MAX_EXTENSIONS: 1,            // 延長は1回まで
  EXTENSION_DAYS: 14,           // 1回の延長で延びる日数
  PENALTY_BASE_DAYS: 3,         // ペナルティ基本停止日数
  PENALTY_STEP_DAYS: 2,         // 累積1回ごとに加算
  PENALTY_RESET_MONTHS: 3,      // ペナルティ回数リセット期間
  SESSION_TTL_SECONDS: 60 * 60 * 6, // セッション有効期限（6時間）
};
