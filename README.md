# 📚 BOMUbrary — 起業部 本貸し借りサービス

起業部メンバー限定の、**金銭のやりとりが発生しない**クローズドな本の貸し借りサービスです。
蔵書管理・貸出/返却・待ちリスト・レビュー・購入リクエスト・読書会スレッド・バトンリレー・読書バッジ・ペナルティ管理までを、**Google Apps Script（GAS）＋ Google スプレッドシート＋ Discord** だけで実現します（追加コストゼロ）。

> クローズド・無償・部員間のみ → 貸与権・古物営業法ともに非該当、という前提で設計しています。

---

## アーキテクチャ

| レイヤー | 採用技術 |
|---|---|
| フロント／バック | Google Apps Script（GAS）Web App |
| DB | Google スプレッドシート |
| 認証 | Discord OAuth2（`identify` / `guilds.members.read`） |
| 書誌取得 | 国立国会図書館サーチAPI → Google Books API → 手動入力 |
| 通知／Bot | Discord Bot API（DM・チャンネル・Slash Commands） |
| 定期処理 | GAS 時間主導トリガー（cron） |
| UI | React 18 + Tailwind（いずれも CDN、ビルド不要） |

```
src/
├─ appsscript.json     # マニフェスト（スコープ・WebApp設定）
├─ Config.gs           # スクリプトプロパティ／ビジネスルール定数
├─ Utils.gs            # スプレッドシートをDBとして扱う薄いORM（SheetDB）＋共通関数
├─ Setup.gs            # シート初期化・初期タグ/バッジ投入（setup()）
├─ Members.gs          # メンバー・マイページ・ウィッシュリスト
├─ Books.gs            # 蔵書CRUD・ISBN書誌取得
├─ Tags.gs             # タグCRUD・統廃合
├─ Lendings.gs         # 貸出申請/承認/返却/延長/待ちリスト/読了マーク
├─ Penalty.gs          # 遅延ペナルティ計算・執行・リセット
├─ Reviews.gs          # レビュー・読み方ガイド
├─ Requests.gs         # 購入リクエスト・投票
├─ Forum.gs            # 読書会スレッド（読了者のみ）
├─ Baton.gs            # バトンリレー
├─ Badges.gs           # 読書バッジ判定・付与
├─ Admin.gs            # 蔵書統計・遅延者・メンバー管理
├─ Discord.gs          # DM/チャンネル通知・Slash Command Interaction
├─ Commands.gs         # Slash Command 登録（registerSlashCommands()）
├─ Cron.gs             # 定期処理＋トリガー登録（installTriggers()）
├─ Code.gs             # doGet/doPost・RPCエントリポイント
├─ Index.html          # CDN読み込み・Tailwind設定
├─ Styles.html         # カスタムCSS
├─ Components.html     # 共通UIコンポーネント
├─ Pages.html          # 各ページ
└─ App.html            # ルーティング・グローバル状態・GAS通信
```

---

## セットアップ手順

### 0. 前提
- Google アカウント（スプレッドシート＋GAS）
- 起業部の Discord サーバー（ギルド）と、その管理権限
- [clasp](https://github.com/google/clasp)（任意。手動コピペでも可）

### 1. スプレッドシートと GAS プロジェクトを用意
1. Google スプレッドシートを新規作成し、その **スプレッドシートID**（URLの `/d/＜ID＞/edit`）を控える。
2. GAS プロジェクトを作成（スタンドアロン or スプレッドシートのコンテナバインド）。
3. `src/` 以下のファイルを GAS プロジェクトに反映する。

clasp を使う場合:
```bash
npm i -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json   # scriptId を自分のものに書き換える
clasp push
```

### 2. Discord アプリ／Bot を作成
1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application。
2. **OAuth2**:
   - Redirect に GAS Web App の `/exec` URL を追加（デプロイ後に確定。後述）。
   - スコープ: `identify`, `guilds.members.read`。
3. **Bot**: Bot を追加してトークンを取得。サーバーに招待（`bot` `applications.commands` スコープ）。
   - DM 送信のため、対象メンバーと Bot が同じサーバーにいる必要があります。
4. （Slash Commandsを使う場合）**General Information → Interactions Endpoint URL** に `/exec` URL を設定。
   - Discord は3秒以内の応答を要求します。GAS のコールドスタート次第では失敗することがあります（仕様書「未決定事項」参照。必要なら Cloud Functions 等で受けて GAS に委譲）。

### 3. スクリプトプロパティを設定
GASエディタ →「プロジェクトの設定」→「スクリプトプロパティ」に以下を登録:

| キー | 必須 | 内容 |
|---|---|---|
| `SPREADSHEET_ID` | ✅ | DBに使うスプレッドシートID |
| `DISCORD_CLIENT_ID` | ✅ | Discord アプリの Client ID |
| `DISCORD_CLIENT_SECRET` | ✅ | Discord アプリの Client Secret |
| `DISCORD_BOT_TOKEN` | ✅ | Bot トークン |
| `DISCORD_GUILD_ID` | ✅ | 起業部 Discord サーバーID |
| `NOTIFY_CHANNEL_ID` | 任意 | 遅延・投票の全体通知チャンネルID |
| `GOOGLE_BOOKS_API_KEY` | 任意 | Google Books API キー（無くても動作） |
| `ADMIN_DISCORD_IDS` | 任意 | 初期管理者の Discord ID（カンマ区切り） |
| `WEBAPP_URL` | 任意 | デプロイ後の `/exec` URL（OAuthリダイレクト用に明示推奨） |

### 4. Web App としてデプロイ
GASエディタ →「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」:
- 実行するユーザー: **自分**
- アクセスできるユーザー: **全員**（認証は Discord 側で行うため匿名アクセスを許可）

発行された `/exec` URL を **Discord の Redirect / Interactions Endpoint** と、必要なら `WEBAPP_URL` に設定します。

### 5. 初期化スクリプトを実行
GASエディタの関数選択から、順に実行:
1. `setup()` … シート作成＋初期タグ/バッジ投入＋初期管理者登録
2. `installTriggers()` … cron トリガー登録
3. `registerSlashCommands()` …（Bot を使う場合）Slash Command 登録

初回実行時に OAuth 権限の承認を求められます。

---

## 主な機能

- **蔵書管理**: ISBNから書誌自動取得（NDL→Google Books→手動）、タグ付け、コンディション、状態（空き/貸出中）、検索・フィルタ
- **貸出管理**: オーナー承認制の貸出申請、標準2週間（300ページ以上は4週間）、延長は1回・オーナー承認制、待ちリスト、読了マーク
- **ペナルティ**: 返却遅延で借出停止（`3 + 2n` 日、直近3ヶ月の累積、3ヶ月で初回扱いにリセット）。遅延は部内チャンネルで可視化
- **レビュー**: 星評価＋ひとこと（必須）＋読み方ガイド（任意項目群）
- **購入リクエスト**: 投票で可視化、管理者が購入判断 → 購入で蔵書へ自動登録＋起案者へDM
- **読書会スレッド**: 読了マークが付いた人のみ投稿可。投稿で他の読了者へDM
- **バトンリレー**: 次の読み手を指名＋コメント、履歴の可視化
- **読書バッジ**: 9種のバッジを条件達成で自動付与
- **マイページ／管理画面**: 借り中・読了・バッジ・ウィッシュリスト／蔵書統計・遅延者・メンバー/タグ/ペナルティ管理

---

## cron（GAS時間主導トリガー）

| トリガー | 処理 |
|---|---|
| 毎日 09:00 | 返却期限3日前・当日のDMリマインド、`pending_enrichment` の書誌再取得 |
| 毎時 | 待ちリスト先頭への通知 |
| 毎日 00:00 | バッジ自動判定・付与、ペナルティ回数の3ヶ月リセット |

`installTriggers()` で登録されます。

---

## 認証フロー（Discord OAuth2 on GAS）

```
[Discordでログイン] → Discord認可画面 → /exec?code=... へコールバック（doGet）
  → code を access_token に交換 → ユーザー情報＋ギルドメンバー確認
  → members シートの discord_id と照合（ホワイトリスト）
  → セッショントークン発行（CacheService + sessions シート）
  → トークンを sessionStorage / URLハッシュ経由でフロントへ受け渡し
```

各 `google.script.run` 呼び出しはフロントの `gasCall` ラッパーがセッショントークンを自動で先頭引数に付与し、サーバー側で本人確認します。

> GAS の Web App は usercontent iframe で動作するため、ログイン後のトークン受け渡しは `sessionStorage` と URLハッシュ（`#token=`）の二段構えにしています。環境によりどちらか一方が機能します。

---

## 注意・既知の制約

- **Slash Command の3秒制約**: GAS のコールドスタートが重い場合、Interaction 応答が間に合わないことがあります。重要な操作は Web App 側で完結させ、Bot は通知・軽量な照会に寄せる運用を推奨（仕様書の未決定事項）。
- **初回ロード**: Babel Standalone（約800KB）＋ React の CDN 読み込みで1〜2秒。Spinner／スケルトンで体感を補っています。
- **`google.script.run` の遅延**: 1呼び出し1〜3秒。変化の少ないデータは `sessionStorage` キャッシュ等で呼び出し回数を抑える設計です。
- スプレッドシートをそのまま DB に使うため、大量データ・高頻度アクセスには向きません（部活規模を想定）。
