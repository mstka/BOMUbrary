# BOMUbrary Discord Proxy Worker

GAS から Discord API を叩くと egress IP が `40333 internal network error` で弾かれる問題を
回避するための Cloudflare Worker。あわせて Slash Command の Interactions エンドポイントも担当し、
ed25519 署名検証と「3秒以内 defer → 裏で GAS 生成 → followup」を行う。

```
[送信] GAS ──X-Proxy-Secret──▶ Worker ──▶ discord.com
[受信] Discord ──/interactions──▶ Worker(署名検証/即defer) ──▶ GAS(/exec で本文生成) ──followup──▶ Discord
```

## デプロイ手順

### 1. 依存と認証
```bash
cd worker
npm i -g wrangler      # 未導入なら
wrangler login
```

### 2. シークレットを登録
```bash
wrangler secret put DISCORD_PUBLIC_KEY   # Discord アプリ General Information の Public Key
wrangler secret put DISCORD_APP_ID       # Application (Client) ID
wrangler secret put GAS_EXEC_URL         # GAS Web App の /exec URL
wrangler secret put PROXY_SECRET         # 任意の推測困難な文字列（GAS と共有）
```

### 3. デプロイ
```bash
wrangler deploy
```
発行された URL（例 `https://bomu-discord-proxy.<you>.workers.dev`）を控える。

### 4. GAS 側のスクリプトプロパティを設定
| キー | 値 |
|---|---|
| `DISCORD_PROXY_BASE` | Worker の URL（例 `https://bomu-discord-proxy.<you>.workers.dev`） |
| `DISCORD_PROXY_SECRET` | 上の `PROXY_SECRET` と同じ値 |

これで GAS の全 Discord 送信（通知・コマンド登録）が Worker 経由になる。
`discordDiagnostics()` を実行すると「経路: Worker中継(...)」と出て、各エンドポイントが 200 になるはず。

### 5. Discord の Interactions Endpoint を Worker に向ける
Discord Developer Portal → アプリ → **General Information → Interactions Endpoint URL** に:
```
https://bomu-discord-proxy.<you>.workers.dev/interactions
```
を設定して保存。保存時に Discord が PING を送り、Worker が署名検証して PONG を返すと検証成功。

### 6. Slash Command を登録
Worker 経由で GAS から登録できるようになる:
- GAS で `registerSlashCommands()` を実行（`DISCORD_PROXY_BASE` 経由で 40333 を回避）
- もしくは手元PCから `scripts/register-commands.sh`

## 動作確認
- `GET https://.../`（ブラウザ）→ `OK` テキスト
- `discordDiagnostics()`（GAS）→ 全エンドポイント 200
- Discord で `/book list` などを実行 → 数秒後に結果が返る（defer→followup）

## セキュリティ
- 送信プロキシは `X-Proxy-Secret` が一致しないと 403。Bot トークンは GAS→Worker のヘッダーで
  都度渡され、Worker は保持しない。
- Interactions は ed25519 署名検証必須（`DISCORD_PUBLIC_KEY`）。検証失敗は 401。
