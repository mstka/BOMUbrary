#!/usr/bin/env bash
#
# register-commands.sh
# Discord Slash Commands を「手元のPCから」ギルドに一括登録するスクリプト。
#
# GAS の egress IP から applications/guilds 系ルートを叩くと Discord エッジに
# 40333「internal network error」で弾かれることがあるため、その回避用。
# コマンド登録は一度きりの作業なので、ローカルから実行すれば確実。
#
# 使い方:
#   export DISCORD_CLIENT_ID=...     # アプリの Client ID
#   export DISCORD_GUILD_ID=...      # 起業部サーバー(ギルド)ID
#   export DISCORD_BOT_TOKEN=...     # Bot トークン
#   bash scripts/register-commands.sh
#
# 接続テストだけしたい場合:
#   bash scripts/register-commands.sh --clear   # 既存コマンドを空にする（=接続疎通確認）
#
set -euo pipefail

: "${DISCORD_CLIENT_ID:?DISCORD_CLIENT_ID を設定してください}"
: "${DISCORD_GUILD_ID:?DISCORD_GUILD_ID を設定してください}"
: "${DISCORD_BOT_TOKEN:?DISCORD_BOT_TOKEN を設定してください}"

API="https://discord.com/api/v10"
UA="DiscordBot (https://github.com/mstka/BOMUbrary, 1.0)"
URL="$API/applications/${DISCORD_CLIENT_ID}/guilds/${DISCORD_GUILD_ID}/commands"

# --clear: 空配列をPUT（既存コマンド全削除＝疎通確認に使える）
if [[ "${1:-}" == "--clear" ]]; then
  PAYLOAD='[]'
else
# option type: 1=SUB_COMMAND, 3=STRING, 6=USER
PAYLOAD=$(cat <<'JSON'
[
  {
    "name": "book", "description": "蔵書の閲覧・検索",
    "options": [
      { "type": 1, "name": "list", "description": "空き本の一覧" },
      { "type": 1, "name": "search", "description": "タイトル・タグで検索",
        "options": [ { "type": 3, "name": "キーワード", "description": "検索キーワード", "required": true } ] },
      { "type": 1, "name": "info", "description": "本の詳細",
        "options": [ { "type": 3, "name": "title", "description": "本のタイトル", "required": true } ] }
    ]
  },
  {
    "name": "lend", "description": "貸出・返却・延長",
    "options": [
      { "type": 1, "name": "request", "description": "貸出申請",
        "options": [ { "type": 3, "name": "title", "description": "本のタイトル", "required": true } ] },
      { "type": 1, "name": "return", "description": "返却報告",
        "options": [ { "type": 3, "name": "title", "description": "本のタイトル", "required": true } ] },
      { "type": 1, "name": "extend", "description": "延長申請",
        "options": [ { "type": 3, "name": "title", "description": "本のタイトル", "required": true } ] }
    ]
  },
  {
    "name": "waitlist", "description": "待ちリスト",
    "options": [
      { "type": 1, "name": "join", "description": "待ちリスト登録",
        "options": [ { "type": 3, "name": "title", "description": "本のタイトル", "required": true } ] }
    ]
  },
  {
    "name": "review", "description": "レビュー投稿",
    "options": [ { "type": 3, "name": "title", "description": "本のタイトル", "required": true } ]
  },
  {
    "name": "request", "description": "購入リクエスト",
    "options": [
      { "type": 1, "name": "add", "description": "リクエスト投稿",
        "options": [
          { "type": 3, "name": "title", "description": "タイトル", "required": true },
          { "type": 3, "name": "reason", "description": "読みたい理由", "required": false }
        ] },
      { "type": 1, "name": "list", "description": "リクエスト一覧" },
      { "type": 1, "name": "vote", "description": "リクエストに+1",
        "options": [ { "type": 3, "name": "title", "description": "本のタイトル", "required": true } ] }
    ]
  },
  { "name": "mypage", "description": "自分の借り中・読了・バッジ" },
  {
    "name": "baton", "description": "バトンリレー指名",
    "options": [
      { "type": 3, "name": "title", "description": "本のタイトル", "required": true },
      { "type": 6, "name": "member", "description": "指名する部員", "required": true }
    ]
  }
]
JSON
)
fi

echo "PUT $URL"
HTTP_CODE=$(curl -sS -o /tmp/bomu_cmd_resp.json -w '%{http_code}' -X PUT "$URL" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "User-Agent: ${UA}" \
  -d "$PAYLOAD")

echo "HTTP ${HTTP_CODE}"
echo "----- response -----"
cat /tmp/bomu_cmd_resp.json; echo
rm -f /tmp/bomu_cmd_resp.json

if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]]; then
  echo "✅ 登録に成功しました。"
else
  echo "❌ 失敗（HTTP ${HTTP_CODE}）。"
  echo "  - 401: BOT_TOKEN を確認"
  echo "  - 403/50001: Bot を bot+applications.commands スコープでサーバーに招待し直す"
  echo "  - 403/40333: 時間をおいて再実行（Discord/エッジ側の一時事象）"
  exit 1
fi
