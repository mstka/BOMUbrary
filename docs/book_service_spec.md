# 起業部 本貸し借りサービス — 機能仕様まとめ

## 前提・方針

- **対象**: 起業部メンバー限定のクローズドサービス
- **金銭のやりとり**: なし（著作権法・古物営業法のリスク回避）
- **ペナルティ**: 金銭ではなく権限制限と評判で運用
- **法律クリア条件**: クローズド・無償・部員間のみ → 貸与権・古物営業法ともに非該当

---

## 技術スタック

| レイヤー | 内容 |
|---|---|
| フロントエンド・バックエンド | Google Apps Script（GAS）Web App |
| DB | Google スプレッドシート |
| 認証 | Discord OAuth2（Discordログイン） |
| ISBN書誌取得 | 国立国会図書館サーチAPI（メイン）→ Google Books API（フォールバック）→ 手動入力（最終フォールバック） |
| 通知 | GAS MailApp（メール）+ Discord Bot API（Discordへの通知） |
| ホスティング | GAS Web App のデプロイ URL |
| Discord連携 | Discord Bot（Slash Commands / DM通知 / チャンネル通知） |

### GAS × スプレッドシート構成の特徴

- **追加コストゼロ** — Googleアカウントがあれば動く
- **スプレッドシートがそのままDB** — 部員が直接データを確認・修正しやすい
- **GASのトリガー機能**で返却期限通知などの定期処理が実現できる

### Discord OAuth2 on GAS の構成

GASはサーバーレスのため、OAuth2コールバックを`doGet()`で受け取る特殊な実装になる。

```
ユーザーが「Discordでログイン」をクリック
  ↓
Discord OAuth2 認証画面にリダイレクト
  ↓
ユーザーが許可
  ↓
GAS Web AppのdoGet()にauthorization codeが返ってくる
  ↓
GAS側でcodeをaccess_tokenに交換（Discord API）
  ↓
access_tokenでDiscordユーザー情報（ID・ユーザー名・アバター）を取得
  ↓
起業部サーバーのメンバーか確認（guilds.members.read スコープ）
  ↓
membersシートのdiscord_idと照合 → 一致でログイン成功
  ↓
GAS側でセッショントークンを発行・CacheServiceで管理
```

**OAuth2スコープ**
- `identify` — ユーザーID・ユーザー名・アバター取得
- `guilds.members.read` — 起業部Discordサーバーのメンバーか確認・ロール取得

---

## Discord Bot UI/UX

Web AppとBotを**2本立て**で運用する。GAS Web Appが本体のUI、Discord Botが通知・クイック操作のUIになる。

### Bot でできること（Slash Commands）

| コマンド | 内容 |
|---|---|
| `/book list` | 空き本の一覧を表示 |
| `/book search [キーワード]` | タイトル・タグで本を検索 |
| `/book info [タイトル]` | 本の詳細・貸出状況・レビュー概要を表示 |
| `/lend request [タイトル]` | 貸出申請（Web Appに遷移するボタン付き） |
| `/lend return [タイトル]` | 返却報告 |
| `/lend extend [タイトル]` | 延長申請（オーナーに確認DMが飛ぶ） |
| `/waitlist join [タイトル]` | 待ちリスト登録 |
| `/review [タイトル]` | レビュー投稿（Web Appに遷移するボタン付き） |
| `/request add [タイトル]` | 購入リクエスト投稿 |
| `/request list` | 購入リクエスト一覧表示 |
| `/request vote [タイトル]` | 購入リクエストに+1 |
| `/mypage` | 自分の借り中・読了・バッジをDMで通知 |
| `/baton [タイトル] [@メンバー]` | バトンリレー指名 |

### Bot からの自動通知（DM or チャンネル）

| タイミング | 通知先 | 内容 |
|---|---|---|
| 返却期限3日前 | 借りてる人のDM | 返却期限リマインド |
| 返却期限当日 | 借りてる人のDM | 返却期限当日アラート |
| 返却遅延発生 | 借りてる人のDM + 部内チャンネル | 遅延通知・全員可視化 |
| 待ちリスト順番 | 次の人のDM | 「〇〇が返却されました、借りますか？」 |
| バトン指名 | 指名された人のDM | 「〇〇さんから△△を勧められました」 |
| 貸出申請 | オーナーのDM | 「〇〇さんが借りたいと言っています」 |
| 延長申請 | オーナーのDM | 「〇〇さんが延長を希望しています」（承認/拒否ボタン付き） |
| バッジ取得 | 取得者のDM | 「バッジ獲得！」 |
| 購入リクエスト投票 | 部内チャンネル | 投票があったことを共有 |

---

## スプレッドシート DB 設計

### シート一覧

| シート名 | 役割 |
|---|---|
| `books` | 蔵書マスタ |
| `members` | メンバーマスタ |
| `lendings` | 貸出履歴 |
| `waitlist` | 待ちリスト |
| `reviews` | レビュー |
| `tags` | タグマスタ |
| `book_tags` | 本とタグの紐づけ（中間テーブル） |
| `requests` | 購入リクエスト |
| `request_votes` | リクエスト投票 |
| `forum_posts` | 読書会スレッド投稿 |
| `baton` | バトンリレー履歴 |
| `badges` | バッジマスタ |
| `member_badges` | 部員バッジ取得履歴 |
| `wishlists` | ウィッシュリスト |
| `penalty_log` | ペナルティ履歴 |

### 各シートのカラム

#### `books`
| カラム | 型 | 内容 |
|---|---|---|
| book_id | string | UUID |
| title | string | タイトル |
| author | string | 著者 |
| publisher | string | 出版社 |
| isbn | string | ISBN（13桁） |
| cover_url | string | 表紙画像URL |
| page_count | number | ページ数 |
| condition | string | 新品 / 良好 / 使用感あり / メモ書きあり |
| status | string | available / lending / unavailable |
| owner_id | string | 登録者のmember_id |
| external_link | string | Amazon等の関連リンク |
| pending_enrichment | boolean | 書誌情報の自動補完待ちフラグ |
| registered_at | datetime | 登録日時 |

#### `members`
| カラム | 型 | 内容 |
|---|---|---|
| member_id | string | UUID |
| discord_id | string | DiscordユーザーID（ログイン識別子） |
| discord_username | string | Discordユーザー名 |
| avatar_url | string | Discordアバター画像URL |
| role | string | admin / member |
| penalty_until | datetime | 借出停止期限（ペナルティ中のみ） |
| penalty_count | number | 直近3ヶ月以内のペナルティ回数 |
| last_penalty_at | datetime | 最後にペナルティが課された日時 |
| joined_at | datetime | 登録日時 |

#### `lendings`
| カラム | 型 | 内容 |
|---|---|---|
| lending_id | string | UUID |
| book_id | string | 対象本 |
| borrower_id | string | 借りた人のmember_id |
| lent_at | datetime | 貸出日 |
| due_date | datetime | 返却期限 |
| returned_at | datetime | 実際の返却日（未返却はblank） |
| extended | boolean | 延長済みフラグ |
| return_condition | string | 返却時のコンディション報告 |

#### `waitlist`
| カラム | 型 | 内容 |
|---|---|---|
| waitlist_id | string | UUID |
| book_id | string | 対象本 |
| member_id | string | 待ち登録した人 |
| registered_at | datetime | 登録日時 |
| notified | boolean | 通知済みフラグ |

#### `reviews`
| カラム | 型 | 内容 |
|---|---|---|
| review_id | string | UUID |
| book_id | string | 対象本 |
| member_id | string | 投稿者 |
| stars | number | 1〜5 |
| comment | string | ひとこと感想（必須） |
| read_timing | string | 読むのに最適なフェーズ（任意） |
| recommended_chapter | string | おすすめ章のコメント（任意） |
| for_whom | string | こんな人におすすめ（任意） |
| pair_book | string | 組み合わせおすすめ本（任意） |
| applied_to | string | 自分のプロジェクトへの活かし方（任意） |
| posted_at | datetime | 投稿日時 |

#### `tags`
| カラム | 型 | 内容 |
|---|---|---|
| tag_id | string | UUID |
| name | string | タグ名 |
| created_by | string | 作成者のmember_id |
| created_at | datetime | 作成日時 |

#### `book_tags`
| カラム | 型 | 内容 |
|---|---|---|
| book_id | string | 対象本 |
| tag_id | string | タグ |

#### `requests`
| カラム | 型 | 内容 |
|---|---|---|
| request_id | string | UUID |
| title | string | 希望する本のタイトル |
| author | string | 著者（任意） |
| isbn | string | ISBN（任意） |
| reason | string | 読みたい理由 |
| requested_by | string | リクエストしたmember_id |
| status | string | open / purchased / rejected |
| vote_count | number | 得票数（集計用・表示のみ） |
| requested_at | datetime | 投稿日時 |

#### `request_votes`
| カラム | 型 | 内容 |
|---|---|---|
| request_id | string | 対象リクエスト |
| member_id | string | 投票したメンバー |
| voted_at | datetime | 投票日時 |

#### `forum_posts`
| カラム | 型 | 内容 |
|---|---|---|
| post_id | string | UUID |
| book_id | string | 対象本 |
| member_id | string | 投稿者 |
| content | string | 投稿内容 |
| posted_at | datetime | 投稿日時 |

#### `baton`
| カラム | 型 | 内容 |
|---|---|---|
| baton_id | string | UUID |
| book_id | string | 対象本 |
| from_member_id | string | バトンを渡した人 |
| to_member_id | string | 指名された人 |
| message | string | 指名コメント |
| created_at | datetime | 日時 |

#### `badges`
| カラム | 型 | 内容 |
|---|---|---|
| badge_id | string | UUID |
| name | string | バッジ名 |
| condition | string | 取得条件の説明 |

#### `member_badges`
| カラム | 型 | 内容 |
|---|---|---|
| member_id | string | 取得者 |
| badge_id | string | 取得バッジ |
| earned_at | datetime | 取得日時 |

#### `penalty_log`
| カラム | 型 | 内容 |
|---|---|---|
| penalty_id | string | UUID |
| member_id | string | ペナルティ対象者 |
| lending_id | string | 起因となった貸出ID |
| stop_days | number | 停止日数 |
| penalty_at | datetime | ペナルティ執行日時 |
| expires_at | datetime | 停止期限 |

---

## 機能一覧

### 1. 蔵書管理

| 機能 | 詳細 |
|---|---|
| 蔵書登録 | ISBNスキャン or 手動入力。NDL API → Google Books API の順でフォールバック |
| 書誌自動補完 | NDLで取れなかった本はフラグ管理し、GASのcronで毎日再取得・自動補完 |
| コンディション記録 | 登録時に「新品 / 良好 / 使用感あり / メモ書きあり」を記録 |
| タグ付け | ジャンル・フェーズ・読み方等を区別せず統一タグとして付与。全部員が自由に追加可 |
| 状態管理 | 空き / 貸出中 / 返却待ち をリアルタイムで表示 |
| 検索・フィルタ | タイトル・著者・タグ・状態で絞り込み |
| 外部リンク | 蔵書にない関連書籍をAmazon等にリンクして紹介 |

### 2. タグ設計

カテゴリ・フェーズ・読み方などを**すべて統一タグ**として管理。全部員が自由に新規作成可、管理者が統廃合・削除を行う。

**初期タグ例**

| 種別 | タグ例 |
|---|---|
| ジャンル | 起業, マーケ, 技術, 思想, 組織, ファイナンス, 営業, デザイン |
| 起業フェーズ | アイデア期, 開発中, PMF, 営業中, 資金調達, スケール期 |
| 読み方 | 通読向け, ななめ読みOK, 辞書的に使う, 課題図書 |
| 難易度 | 入門, 中級, 上級 |
| 読了時間 | 1日で読める, 1週間目安, じっくり系 |

### 3. 貸出管理

| 機能 | 詳細 |
|---|---|
| 貸出申請 | 借りたい本をアプリ上 or Slash Commandでリクエスト、オーナーが承認 |
| 貸与期間 | 標準2週間。300ページ以上は4週間 |
| 延長申請 | **オーナー承認制**。申請するとオーナーのDiscord DMに承認/拒否ボタン付き通知が飛ぶ。延長は1回まで、待ちリストがいる場合は不可 |
| 返却期限通知 | GAS cronで3日前・当日にDiscord DM通知 |
| 返却時コンディション報告 | 借りた人が返却時に本のコンディションを報告 |
| 待ちリスト | 貸出中の本に順番待ち登録。返却・確認後に次の人にDiscord DM通知 |
| 貸出履歴 | 本ごとに「誰がいつ借りたか」の履歴を記録・表示 |
| 読了マーク | **返却確認後のみ**付与可能。読了マークがついて初めて読書会スレッドに参加できる |

### 4. ペナルティ設計

返却遅延が発生した場合に借出停止ペナルティを課す。**3ヶ月以内の累積**で停止日数が伸びていく。

#### ペナルティ計算ロジック

```
直近3ヶ月以内のペナルティ回数をpenalty_logから取得
  ↓
回数 = 0（初回）→ 停止3日間
回数 = 1（2回目）→ 停止5日間（3 + 2×1）
回数 = 2（3回目）→ 停止7日間（3 + 2×2）
回数 = n（n+1回目）→ 停止（3 + 2×n）日間
```

#### 3ヶ月リセット

`last_penalty_at`から3ヶ月以上空いた状態で新たにペナルティが課される場合、`penalty_count`を0にリセットしてから計算する（つまり初回扱いで3日間）。

#### ペナルティ中の動作

- 借出申請ができない
- Web AppおよびBotで「〇月〇日まで借出停止中」と表示
- 遅延中は部内Discordチャンネルに「返却遅延中」と全員可視化

### 5. レビュー・読み方ガイド

| 項目 | 必須 / 任意 | 内容 |
|---|---|---|
| 星評価 | 必須 | 1〜5 |
| ひとこと感想 | 必須 | 短いコメント |
| 読むタイミング | 任意 | 起業フェーズのどの時期に読むべきか |
| おすすめ章 | 任意 | 「第3章だけでも読む価値あり」など |
| こんな人におすすめ | 任意 | 読者像のメモ |
| 組み合わせおすすめ | 任意 | 「ゼロイチの次にこれ」など関連本 |
| 活かした点 | 任意 | 自分のプロジェクトに実際に使ったこと |

### 6. 購入リクエスト

閾値なし。投票数と理由を**可視化するだけ**。購入の判断は管理者が行う。

| 機能 | 詳細 |
|---|---|
| リクエスト投稿 | タイトル・著者・読みたい理由を投稿 |
| 投票（+1） | 部員がリクエストに投票。票数が全員に見える |
| 一覧表示 | 票数の多い順に並べて可視化 |
| 購入済み処理 | 管理者が購入済みにすると蔵書に自動登録・リクエスト投稿者にDiscord DM通知 |

### 7. 読書会スレッド

| 機能 | 詳細 |
|---|---|
| 本ごとのスレッド | 各本に紐づいたフォーラム形式の投稿スペース |
| 参加資格 | **返却確認後に読了マークがついた人のみ**書き込み可 |
| 通知 | 同じ本の読了者が投稿したらDiscord DM通知 |

### 8. バトンリレー

| 機能 | 詳細 |
|---|---|
| 次の人を指名 | 返却時に「次にこの人に読んでほしい」と部員を指名 |
| 指名コメント | 理由をコメント付きで送れる |
| 指名通知 | 指名された人にDiscord DM通知 |
| バトン履歴 | 本ごとに「誰から誰へバトンが渡ったか」を可視化 |

### 9. 読書バッジ

| バッジ | 取得条件 |
|---|---|
| 初借り | 初めて本を借りる |
| 初レビュー | 初めてレビューを書く |
| タグ職人 | タグを5個以上新規作成する |
| バトンの達人 | バトンリレーを5回以上実施 |
| 蔵書貢献者 | 部の蔵書に3冊以上登録 |
| リクエスター | 購入リクエストが購入済みになる |
| 皆勤返却 | 遅延ゼロで10冊返却 |
| 読書会常連 | 読書会スレッドに10回以上投稿 |
| 読破王 | 読了マークを20冊以上つける |

バッジの追加・カスタマイズは管理者が`badges`シートを直接編集することで対応。

### 10. メンバー・マイページ

| 機能 | 詳細 |
|---|---|
| 借り中の本 | 現在借りている本と返却期限 |
| 読了リスト | 返却確認後に読了マークをつけた本の一覧 |
| ウィッシュリスト | 読みたい本のメモ（蔵書内外問わず） |
| 自分が登録した本 | 自分がオーナーの蔵書一覧 |
| バッジ一覧 | 獲得済みバッジの表示 |
| ペナルティ状況 | 停止中の場合は解除日を表示 |

### 11. 管理機能（部長・幹部向け）

| 機能 | 詳細 |
|---|---|
| 蔵書統計 | 総蔵書数・貸出率・人気本ランキング |
| 遅延者管理 | 返却遅延中のメンバー一覧 |
| 購入リクエスト管理 | 一覧確認・購入済み処理・却下処理 |
| メンバー管理 | Discord IDベースでホワイトリストに追加・削除 |
| タグ管理 | タグの統廃合・削除 |
| ペナルティ管理 | 手動でペナルティ解除・記録確認 |

---

## ISBN書誌取得フロー

```
ISBNスキャン or 手動入力
  ↓
① 国立国会図書館サーチAPI
  → 取れた → 登録完了
  ↓ 取れない（新刊4日以内など）
② Google Books API
  → 取れた → 登録完了
  ↓ 取れない
③ 手動入力フォームにフォールバック
  → pending_enrichment = true で仮登録
  ↓
GAS cronで毎日①②を再試行
  → 取れたら自動補完・フラグ解除・登録者にDiscord DM通知
```

---

## GAS 定期処理（cron）

| トリガー | 処理内容 |
|---|---|
| 毎日 AM9:00 | 返却期限3日前の人にDiscord DM通知 |
| 毎日 AM9:00 | 返却期限当日の人にDiscord DM通知 |
| 毎日 AM9:00 | pending_enrichmentフラグがある本のNDL/Google Books再取得 |
| 毎時 | 待ちリストの先頭に通知が必要か確認 |
| 毎日 AM0:00 | バッジ取得条件の自動チェック・付与 |
| 毎日 AM0:00 | penalty_logから3ヶ月経過分のリセット処理 |

---

## 未決定事項（要議論）

| 項目 | 補足 |
|---|---|
| Discord BotのホスティングをGAS単体でやるか別途立てるか | GASのWebhook受け取りは可能だがInteraction Endpoint（3秒以内応答）が厳しい場合はCloud Functions等を検討 |
| Slash CommandのInteraction応答をGASで捌けるか検証 | Discordの3秒タイムアウト制約とGASの起動時間の相性を要確認 |

---

## フロントエンド技術スタック詳細

### 採用構成

| 役割 | 技術 | バージョン | 備考 |
|---|---|---|---|
| UIフレームワーク | React | 18 | CDN（UMD）経由 |
| JSXトランスパイル | Babel Standalone | latest | ブラウザ上でJSX変換 |
| スタイリング | Tailwind CSS | Play CDN | ビルド不要 |
| アイコン | Lucide React | latest | CDN経由 |
| フォント | Noto Sans JP + Inter | - | Google Fonts |
| ルーティング | ハッシュルーティング（自前） | - | GASはパス変更不可のため |
| サーバー通信 | google.script.run | - | GAS標準の非同期API |
| キャッシュ | sessionStorage | - | GAS呼び出し回数削減 |
| テンプレート分割 | GAS include() | - | コンポーネント的管理 |

---

### GASプロジェクトのファイル構成

```
# サーバーサイド（.gs）
Code.gs            # doGet / doPost エントリポイント
Auth.gs            # Discord OAuth2処理・セッション管理
Books.gs           # 蔵書CRUD
Lendings.gs        # 貸出・返却・延長処理
Reviews.gs         # レビューCRUD
Tags.gs            # タグCRUD
Requests.gs        # 購入リクエスト・投票
Forum.gs           # 読書会スレッド
Baton.gs           # バトンリレー
Badges.gs          # バッジ判定・付与ロジック
Penalty.gs         # ペナルティ計算・執行
Cron.gs            # 定期処理トリガー群
Discord.gs         # Discord Bot API / Webhook呼び出し
Utils.gs           # 共通ユーティリティ（UUID生成等）

# フロントエンド（.html）
Index.html         # エントリポイント・CDN読み込み・Tailwind設定
App.html           # Reactアプリ本体（ルーティング・グローバル状態）
Components.html    # 共通コンポーネント（Button, Card, Modal, Badge等）
Pages.html         # 各ページコンポーネント（本棚・貸出・マイページ等）
Styles.html        # Tailwindで賄えないカスタムCSS
```

---

### CDN読み込み構成（Index.html）

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>起業部 本棚</title>

  <!-- Google Fonts -->
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

  <!-- Tailwind Play CDN -->
  <script src="https://cdn.tailwindcss.com"></script>

  <!-- React 18 -->
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

  <!-- Babel Standalone（JSXトランスパイル） -->
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

  <!-- Lucide Icons -->
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>

  <script>
    // Tailwindカスタム設定
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'Noto Sans JP', 'sans-serif'],
          },
          colors: {
            brand: {
              50:  '#f0f4ff',
              100: '#e0eaff',
              500: '#4f6ef7',
              600: '#3a57d4',
              900: '#1a2b8a',
            }
          },
          borderRadius: {
            xl: '1rem',
            '2xl': '1.5rem',
          }
        }
      }
    }
  </script>

  <?!= include('Styles'); ?>
</head>
<body class="bg-gray-50 font-sans text-gray-900 antialiased">
  <div id="root"></div>

  <?!= include('Components'); ?>
  <?!= include('Pages'); ?>
  <?!= include('App'); ?>
</body>
</html>
```

---

### Reactアプリの基本構造（App.html）

```html
<script type="text/babel">
const { useState, useEffect, useCallback, createContext, useContext } = React;

// ─── グローバル状態（Context） ───────────────────────────
const AppContext = createContext(null);

function useApp() {
  return useContext(AppContext);
}

// ─── google.script.run のPromiseラッパー ─────────────────
function gasCall(fnName, ...args) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(reject)
      [fnName](...args);
  });
}

// ─── ハッシュルーター ────────────────────────────────────
function useRouter() {
  const [page, setPage] = useState(
    location.hash.replace('#/', '') || 'books'
  );

  useEffect(() => {
    const handler = () => {
      setPage(location.hash.replace('#/', '') || 'books');
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const navigate = (path) => {
    location.hash = `/${path}`;
  };

  return { page, navigate };
}

// ─── アプリ本体 ──────────────────────────────────────────
function App() {
  const { page, navigate } = useRouter();
  const [user, setUser]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast]   = useState(null);

  // 起動時にセッション確認
  useEffect(() => {
    gasCall('getSession')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // トースト通知
  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  if (loading) return <LoadingScreen />;
  if (!user)   return <LoginPage />;

  const pages = {
    books:    <BooksPage />,
    detail:   <BookDetailPage />,
    lendings: <LendingsPage />,
    requests: <RequestsPage />,
    forum:    <ForumPage />,
    mypage:   <MyPage />,
    admin:    <AdminPage />,
  };

  return (
    <AppContext.Provider value={{ user, navigate, gasCall, showToast }}>
      <div className="min-h-screen bg-gray-50">
        <Navbar currentPage={page} navigate={navigate} user={user} />
        <main className="max-w-5xl mx-auto px-4 py-6">
          {pages[page] ?? <BooksPage />}
        </main>
        {toast && <Toast toast={toast} />}
      </div>
    </AppContext.Provider>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
</script>
```

---

### コンポーネント設計方針

#### 共通コンポーネント（Components.html）

```
Button          プライマリ / セカンダリ / デンジャーの3バリアント
Card            本カード・メンバーカード等の汎用カードラッパー
Modal           確認ダイアログ・詳細表示用モーダル
Badge           バッジ・タグ・ステータス表示用ピル
Toast           操作フィードバック通知（3秒で自動消滅）
Spinner         ローディングインジケーター
Avatar          Discordアバター画像 + イニシャルフォールバック
StarRating      レビュー用の星評価コンポーネント
TagSelector     タグ選択・新規追加コンポーネント
SearchBar       検索・フィルタバー
EmptyState      データなし時のイラスト+メッセージ
```

#### ページコンポーネント（Pages.html）

```
LoginPage       Discordログインボタンのみのシンプル画面
BooksPage       蔵書一覧・検索・フィルタ
BookDetailPage  本の詳細・貸出履歴・レビュー・バトン履歴
LendingsPage    貸出申請・返却・延長申請
RequestsPage    購入リクエスト一覧・投票
ForumPage       読書会スレッド（読了者のみ）
MyPage          マイページ（借り中・読了・バッジ・ウィッシュリスト）
AdminPage       管理画面（部長・幹部のみ表示）
```

---

### google.script.run の使い方パターン

GASのサーバー関数呼び出しはコールバックベースやが、Promiseにラップして使う。

```javascript
// ① 基本パターン（gasCallユーティリティ経由）
const books = await gasCall('getBooks');

// ② 引数あり
const book = await gasCall('getBookById', bookId);

// ③ useEffectでの初期データ取得
useEffect(() => {
  setLoading(true);
  gasCall('getBooks')
    .then(setBooks)
    .catch(() => showToast('取得に失敗しました', 'error'))
    .finally(() => setLoading(false));
}, []);

// ④ sessionStorageキャッシュ併用
async function fetchBooks() {
  const cached = sessionStorage.getItem('books');
  if (cached) return JSON.parse(cached);

  const books = await gasCall('getBooks');
  sessionStorage.setItem('books', JSON.stringify(books));
  return books;
}
```

---

### UX設計方針

| 項目 | 方針 |
|---|---|
| ローディング | Spinner or スケルトンUIで待機状態を明示 |
| エラーハンドリング | Toast通知でフィードバック（赤・3秒） |
| 成功フィードバック | Toast通知（緑・3秒） |
| モバイル対応 | Tailwindのレスポンシブプレフィックスで対応（sm: md: lg:） |
| 初回ロード | Babel + React のCDNで約1〜2秒。Spinnerで体感改善 |
| キャッシュ戦略 | 変化の少ないデータ（蔵書一覧・タグ等）はsessionStorageにキャッシュ |
| ダークモード | Tailwindの`dark:`プレフィックスで対応（将来拡張） |

---

### パフォーマンス上の注意点

GASのWeb App特有の制約として把握しておくこと。

| 項目 | 内容 |
|---|---|
| Babel Standalone | 約800kbのため初回ロードに1〜2秒かかる |
| google.script.run | 1回の呼び出しに1〜3秒かかることがある |
| GASのコールドスタート | しばらく使われてないと最初の呼び出しが特に遅い |
| 対策 | sessionStorageキャッシュ・楽観的UI更新・Spinner必須 |
