# notion-integration

Notion との連携をまとめるリポジトリ。サーバーは使わず、GitHub Actions の定期実行のみで動かす。

## todo-slack-notify

Notion のタスクDBから「ステータスが Done ではない」かつ「実行日が今日以前（今日＋期限切れ）」のタスクを取得し、1通のSlackメッセージにまとめて通知する。対象が0件のときは投稿しない。

- 実行タイミング: 毎日 9:07 / 20:07 JST（`.github/workflows/todo-slack-notify.yml`）
- 本体: `src/todo-slack-notify/index.mjs`
- 「今日」の判定はJST（Asia/Tokyo）基準

### セットアップ

1. **Notion Integration を作成**
   - https://app.notion.com/developers/connections で既存のインテグレーションを確認。無ければ「New integration」で新規作成し、Configuration タブの「Internal Integration Secret」を発行する。
   - 対象のタスクDBが含まれるページで `•••` メニュー → `Add connections` → 作成したインテグレーションを接続する（これをしないとAPIが権限エラーになる）。

2. **data_source_id を取得**
   - `GET https://api.notion.com/v1/databases/{database_id}` を呼ぶと `data_sources` 配列が返るので、その中の `id` を使う。
   - または Notion UI の「Manage data sources」→「Copy data source ID」。

3. **Slack Incoming Webhook を作成**
   - https://api.slack.com/apps で新規アプリを作成（既存のアプリがあれば再利用可）。
   - アプリ設定の「Incoming Webhooks」で `Activate Incoming Webhooks` をオン。
   - 「Add New Webhook to Workspace」で投稿先チャンネルを選んで認可すると、Webhook URL が発行される。

4. **GitHub Secrets を設定**（リポジトリの Settings → Secrets and variables → Actions）
   - `NOTION_API_KEY`
   - `NOTION_DATA_SOURCE_ID`
   - `SLACK_WEBHOOK_URL`

5. ワークフローは `workflow_dispatch` でも手動実行できるので、Secrets設定後に Actions タブから一度手動実行して動作確認する。

### ローカルでの動作確認

```bash
cp .env.example .env
# .env に値を記入してから
export $(grep -v '^#' .env | xargs) && node src/todo-slack-notify/index.mjs
```

### GAS 版（時刻どおりに通知したい場合）

GitHub Actions の `schedule` は数時間遅れることがあるため、Google Apps Script 版を `src/todo-slack-notify-gas/` に用意している。

1. https://script.google.com で新規プロジェクトを作成
2. `Code.gs` の内容を貼り付ける。「プロジェクトの設定」→「appsscript.json マニフェストファイルをエディタで表示」をオンにして、`appsscript.json` の `timeZone` を `Asia/Tokyo` にする
3. 「プロジェクトの設定」→ スクリプト プロパティに `NOTION_API_KEY` / `NOTION_DATA_SOURCE_ID` / `SLACK_WEBHOOK_URL` を登録
4. `notifyTodos` を手動実行して権限を承認し、Slack に届くことを確認
5. `setupTriggers` を一度実行 → 毎日 9時台 / 20時台に自動実行される
6. 二重通知を避けるため、動作確認後に `.github/workflows/todo-slack-notify.yml` の `schedule` を削除する

