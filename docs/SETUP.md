# BOMUbrary セットアップ手順

起業部 本貸し借りサービス（GAS Web App + スプレッドシート + Discord）の構築手順です。
所要時間の目安は **30〜60分**。Google アカウントと、起業部 Discord サーバーの管理権限があれば構築できます。

---

## 0. 用意するもの

| 必要なもの | 用途 |
|---|---|
| Google アカウント | GAS プロジェクト・DB スプレッドシート |
| Discord アカウント＋起業部サーバーの管理権限 | OAuth ログイン・Bot 通知・Slash Commands |
| （任意）[clasp](https://github.com/google/clasp) | ローカルからの GAS への一括反映 |
| （任意）Google Books API キー | ISBN 書誌取得のフォールバック強化 |

> **スプレッドシートは事前に用意しなくてOK**です。手順5の `setup()` が自動で `BOMUbrary DB` という名前のスプレッドシートを作成し、その ID をスクリプトプロパティ `SPREADSHEET_ID` に保存します（詳細は「補足: DBスプレッドシートの扱い」）。

---

## 1. GAS プロジェクトにコードを反映する

### 方法A: clasp（推奨）

```bash
npm i -g @google/clasp
clasp login

# このリポジトリのルートで
cp .clasp.json.example .clasp.json
# .clasp.json の scriptId を、自分の GAS プロジェクトのスクリプトIDに書き換える

clasp push
```

GAS プロジェクトを新規作成する場合は `clasp create --type standalone --title "BOMUbrary"` で作成し、生成された `scriptId` を使います。

### 方法B: 手動コピペ

1. https://script.google.com で新規プロジェクトを作成。
2. `src/` 配下の各ファイルを、GAS エディタで同名のファイルとして作成し、中身を貼り付ける。
   - `*.gs` … スクリプトファイル
   - `*.html` … HTML ファイル（`Index` / `Styles` / `Components` / `Pages` / `App`）
   - `appsscript.json` … マニフェスト（「プロジェクトの設定」→「`appsscript.json` をエディタで表示」をオンにすると編集可）

> マニフェストの `oauthScopes` は、スプレッドシート・外部リクエスト・メール送信・トリガー作成を含みます。初回実行時にこれらの承認を求められます。

---

## 2. Web App としてデプロイし、`/exec` URL を取得する

1. GAS エディタ右上の **「デプロイ」→「新しいデプロイ」**。
2. 種類は **「ウェブアプリ」**。
3. 設定:
   - **実行するユーザー**: 自分
   - **アクセスできるユーザー**: **全員**（認証は Discord 側で行うため、匿名アクセスを許可します）
4. デプロイ後に表示される **ウェブアプリ URL（`.../exec` で終わる URL）** を控える。

> このあと Discord の Redirect URL / Interactions Endpoint と、スクリプトプロパティ `WEBAPP_URL` にこの URL を使います。
> コードを更新したら「デプロイを管理」→ 既存デプロイを編集して「新バージョン」を発行すると、同じ URL のまま反映できます。

---

## 3. Discord アプリ / Bot を作成する

[Discord Developer Portal](https://discord.com/developers/applications) で **New Application**。

### 3-1. OAuth2（ログイン用）
- **OAuth2 → Redirects** に、手順2の `/exec` URL を**そのまま**追加。
- 使用スコープ: `identify`, `guilds.members.read`（コードが自動付与するので Portal 側での固定設定は不要）。
- **Client ID** と **Client Secret** を控える。

### 3-2. Bot（通知・Slash Commands 用）
- **Bot → Add Bot**。**Token** を控える（再表示不可なので保管）。
- Bot をサーバーに招待する。**OAuth2 → URL Generator** で:
  - スコープ: `bot`, `applications.commands`
  - Bot Permissions: `Send Messages` 程度でOK（DM は別途チャンネルを開いて送るため最小限で可）
  - 生成された URL を開いて起業部サーバーに追加。
- **DM 通知の前提**: Bot と通知対象メンバーが同じサーバーに在籍している必要があります。

### 3-3. 各種 ID を控える
- **Guild（サーバー）ID**: Discord の開発者モードを有効化 → サーバー名を右クリック →「サーバーIDをコピー」。
- **通知チャンネル ID**（任意）: 遅延・投票の全体通知を流すチャンネルを右クリック →「チャンネルIDをコピー」。

---

## 4. スクリプトプロパティを設定する

GAS エディタ → **「プロジェクトの設定」⚙ → 「スクリプトプロパティ」** に登録します。

| キー | 必須 | 内容 |
|---|---|---|
| `DISCORD_CLIENT_ID` | ✅ | Discord アプリの Client ID |
| `DISCORD_CLIENT_SECRET` | ✅ | Discord アプリの Client Secret |
| `DISCORD_BOT_TOKEN` | ✅ | Bot トークン |
| `DISCORD_GUILD_ID` | ✅ | 起業部サーバー（ギルド）ID |
| `WEBAPP_URL` | ✅（推奨） | 手順2の `/exec` URL。OAuth リダイレクト先の固定に使用 |
| `NOTIFY_CHANNEL_ID` | 任意 | 遅延・投票の全体通知チャンネル ID |
| `ADMIN_DISCORD_IDS` | 任意 | 初期管理者の Discord ユーザー ID（カンマ区切り） |
| `GOOGLE_BOOKS_API_KEY` | 任意 | Google Books API キー（無くても動作） |
| `SPREADSHEET_ID` | 任意 | **通常は不要**。`setup()` が自動作成・自動保存します。既存スプシを使いたい場合のみ手動設定 |
| `DISCORD_PROXY_BASE` | 任意（推奨） | Cloudflare Worker 中継の URL。設定すると全 Discord 送信が Worker 経由になり 40333 を回避（後述） |
| `DISCORD_PROXY_SECRET` | `DISCORD_PROXY_BASE` 使用時必須 | Worker と共有するシークレット |

> `WEBAPP_URL` を設定しない場合は `ScriptApp.getService().getUrl()` にフォールバックしますが、デプロイ形態によって `/dev` URL になることがあるため、**明示設定を推奨**します。

---

## 5. 初期化スクリプトを実行する

GAS エディタの関数プルダウンから、順番に実行します（初回は OAuth 承認ダイアログが出ます）。

1. **`setup()`**
   - DB スプレッドシートを用意（無ければ自動作成し `SPREADSHEET_ID` を保存）
   - 15 シートを作成・ヘッダー整形
   - 初期タグ（ジャンル/フェーズ/読み方/難易度/読了時間）と 9 種のバッジを投入
   - `ADMIN_DISCORD_IDS` のユーザーを管理者として登録
   - 実行ログにスプレッドシート URL が出力されます
2. **`installTriggers()`**
   - cron トリガーを登録（毎日9:00 / 毎時 / 毎日0:00）
3. **`registerSlashCommands()`**（Bot を使う場合）
   - `/book` `/lend` `/waitlist` `/review` `/request` `/mypage` `/baton` をギルドに一括登録

---

## 6. Discord Interactions Endpoint を設定する（Slash Commands を使う場合）

1. Developer Portal → **General Information → Interactions Endpoint URL** に、手順2の `/exec` URL を設定して保存。
2. Discord が検証リクエストを送ります。

> **既知の制約**: Discord は Interaction に **3秒以内**の応答を要求します。GAS はコールドスタートが重いと間に合わないことがあります（仕様書「未決定事項」）。
> また Discord のエンドポイント検証は ed25519 署名の検証を要求しますが、GAS には native の検証手段がありません。Slash Commands が安定しない場合は、**Bot は通知・軽い照会に留め、重要操作は Web App 側で完結**させる運用を推奨します。必要なら Cloud Functions 等で受けて GAS に委譲する構成を検討してください。

---

## 6.5 Cloudflare Worker 中継（40333 回避・推奨）

GAS から Discord を直接叩くと、egress IP に対し `40333 internal network error` で
特定ルート（applications/guilds 系、場合により通知系）が弾かれることがある。
これを回避し、Slash Command も安定動作させるための薄い中継 Worker を用意している。

詳細は [`worker/README.md`](../worker/README.md) を参照。要点:

1. `worker/` で `wrangler deploy`、シークレット（`DISCORD_PUBLIC_KEY` / `DISCORD_APP_ID` /
   `GAS_EXEC_URL` / `PROXY_SECRET`）を登録。
2. GAS のスクリプトプロパティに `DISCORD_PROXY_BASE`（Worker URL）と
   `DISCORD_PROXY_SECRET`（= `PROXY_SECRET`）を設定。
3. Discord の **Interactions Endpoint URL** を `https://<worker>/interactions` に設定。
4. `discordDiagnostics()` で全エンドポイントが 200 になることを確認 → `registerSlashCommands()`。

Worker は (1) 送信プロキシ（GAS→Worker→Discord）と (2) Interactions の署名検証＋3秒defer＋
GAS委譲followup の両方を担う。GAS は本文生成に専念できる。

> Worker を使わない場合でも、通知系（`channels/*`）が GAS から通るなら運用は可能。
> Slash Command 登録だけは `scripts/register-commands.sh`（手元PC）で代替できる。

## 7. 動作確認チェックリスト

- [ ] `/exec` URL を開くと「Discordでログイン」画面が表示される
- [ ] ログインすると本棚画面に遷移する（部員リスト外のアカウントは弾かれる）
- [ ] 本を登録できる（ISBN を入れて「書誌取得」で NDL / Google Books から自動補完）
- [ ] 別アカウントで貸出申請 → オーナーに DM が届き、詳細画面で承認できる
- [ ] 返却 → 読了マーク → 読書会スレッドに投稿できる
- [ ] 管理者アカウントで「管理」タブに統計・遅延者・メンバー管理が出る
- [ ] スプレッドシートの各シートに行が追加されていく

---

## 補足: DB スプレッドシートの扱い

データ層 `SheetDB`（`src/Core.gs` 内）はスプレッドシートを次の優先順位で解決します。

```
1. スクリプトプロパティ SPREADSHEET_ID があれば openById(ID)
2. 無ければ getActiveSpreadsheet()（コンテナバインド時のみ有効）
```

**重要**: Web App としてデプロイした実行文脈では `getActiveSpreadsheet()` は `null` になります。
そのため本サービスは **`SPREADSHEET_ID` による参照が前提**です。手順5の `setup()` が初回に
スプレッドシートを作成（または既存/アクティブを採用）して `SPREADSHEET_ID` を自動保存するので、
通常は手動設定不要です。既存のスプレッドシートを DB に使いたい場合のみ、`setup()` 実行前に
`SPREADSHEET_ID` を手動で設定してください。

---

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `スプレッドシートが見つかりません` | `setup()` を未実行。先に `setup()` を実行（`SPREADSHEET_ID` が自動保存される） |
| ログイン後に「部員リストに登録されていません」 | `members` シートに該当 `discord_id` が無い。管理画面の「メンバー管理」または `ADMIN_DISCORD_IDS` で登録 |
| OAuth で `redirect_uri` エラー | Developer Portal の Redirects と `WEBAPP_URL` が `/exec` URL と完全一致しているか確認 |
| ログインは成功するがアプリに戻れない | GAS は usercontent iframe で動くため、トークンを `sessionStorage` と URL ハッシュの二段で受け渡し。ブラウザの sessionStorage / サードパーティ Cookie 設定を確認 |
| DM が届かない | Bot トークン未設定、または Bot と対象ユーザーが同じサーバーに居ない。`DISCORD_BOT_TOKEN` と在籍を確認 |
| Slash Command が無反応 | 3秒制約・署名検証の制約（手順6参照）。Web App 側操作で代替可能 |
| `registerSlashCommands()` が `403 / code:40333 "internal network error"` | GAS の egress IP に対し Discord エッジが applications/guilds 系ルートを一時的に拒否する事象（`users/@me` は通るのにこれらだけ失敗するのが典型）。**コード/設定の問題ではない**。まず `discordDiagnostics()`（`Discord.gs`）で切り分け。回避策として**手元のPCから登録**できる `scripts/register-commands.sh` を用意（下記） |

#### Slash Command 登録が GAS から通らない場合（推奨フォールバック）

`registerSlashCommands()` が 40333 で繰り返し失敗する場合、登録は一度きりの作業なので
**手元PCから**実行すれば確実です。

```bash
export DISCORD_CLIENT_ID=...
export DISCORD_GUILD_ID=...
export DISCORD_BOT_TOKEN=...

# まず疎通確認（既存コマンドを空にするだけ・安全）
bash scripts/register-commands.sh --clear

# 本登録
bash scripts/register-commands.sh
```

`--clear` が 200 を返せばネットワーク疎通はOK。続けて本登録してください。
（通知系 DM/チャンネル送信は別ルートのため、この事象の影響を受けないことが多いですが、
もし DM も GAS から送れない場合はご相談ください。）
| 書誌が取得できない | 新刊で NDL/openBD/Google Books 未収録の可能性。`pending_enrichment=true` で仮登録され、毎日9:00 の cron が再取得します |
| 表紙画像が表示されない/壊れる | 旧版は NDL サムネイルURLを使っており CloudFront で 403 になります。最新版は openBD→Google Books から表紙を解決します。既存データは `fixBrokenCovers()`（`Core.gs`）を一度実行すると再解決されます |
