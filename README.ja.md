# DiffChecker

[English](README.md) | **日本語**

AI によるコード変更を承認する前に、変更内容と理由を把握し、VS Code 風の差分を確認し、
個々の差分について実装を担当したエージェントに質問できるツールです。
Node.js の CLI とローカルのブラウザー UI で動作し、npm の依存パッケージはありません。

## 主な機能

- エージェントが作成した作業概要、設計理由、ファイルごとの説明。
- Monaco による左右比較と、利用できない場合の統合差分表示。
- ライブモードで、同じエージェントに差分単位で質問。
- Markdown のプレビューと、修正後の差分更新。
- レビュー完了または画面を閉じた際に、フィードバックをエージェントへ返却。

## 必要な環境と対応状況

**Node.js 20 以上**、Git、最新のブラウザーが必要です。前提ソフトウェアは別途導入してください。
セットアップはソフトウェアの自動ダウンロード、管理者権限の要求、暗黙のスキル変更を行いません。

| OS | ブラウザーの起動方法 | 検証状況 |
| --- | --- | --- |
| Windows | `start` で既定のブラウザーを起動 | ローカルテストと分離環境での npm パッケージ動作確認 |
| macOS | `open` | 対応を想定。実機検証は未完了 |
| Linux デスクトップ | `xdg-open` | 対応を想定。実機検証は未完了 |

ヘッドレス環境では `--no-open` を使用します。サーバーは `127.0.0.1` のみで待ち受けるため、
表示された URL は、そのループバックアドレスにアクセスできる環境で開いてください。

## GitHub からインストール

Node.js と Git を導入してから実行します。

```sh
npm install --global git+https://github.com/Mirko87-stack/DiffChecker.git
diffchecker doctor
diffchecker setup --dry-run
diffchecker setup
```

GitHub の現在の `main` ブランチから導入します。安定版のタグ付きリリースではありません。
コマンドはソースのチェックアウト先に依存しません。`codediff` は互換用に残ります。
パッケージ名は `@mirko87-stack/diffchecker` ですが、npm レジストリーへの公開は不要です。
権限エラーの場合はユーザーが書き込める npm prefix または Node バージョン管理ツールを利用し、
自動昇格しないでください。コマンドが見つからない場合はグローバル bin の PATH を確認し、
修正後にエージェントやターミナルを再起動してください。

## エージェントの設定

既存の Claude Code (`~/.claude`)、Codex (`~/.codex`)、Pi (`~/.pi/agent`) を検出し、
それぞれの `skills/codediff-show/SKILL.md` に配置します。必要に応じてエージェントを再起動するか、
スキルを再読み込みしてください。保存先を指定する場合、空白を含むパスは引用符で囲みます。

```sh
diffchecker setup --target "/path/to/agent/skills" --dry-run
diffchecker setup --target "/path/to/agent/skills"
```

`--target` は複数指定できます。書き込み前に全保存先を検査し、同じ内容のファイルは変更しません。
内容が異なる既存スキルやリンクされた保存先がある場合は中止します。競合するスキルは内容を確認して
バックアップし、ご自身で削除するか、別の保存先を選んでください。`--force` はありません。
予期しないファイルシステムエラーによる途中停止はあり得ます。完全なトランザクション処理ではありません。
導入済みスキルはソースの固定パスではなく、`diffchecker` コマンドを使用します。

エージェントには **「codediff-show スキルで今回の作業をレビューして」** と依頼します。
ライブレビュー中は元のエージェントが質問の受信と回答を続ける必要があります。
AI モデル自体は同梱していません。Claude のセッション通知は補助機能であり、動作保証はありません。

## 使用方法

変更のある Git リポジトリーで実行します。

```sh
diffchecker open --repo . --base HEAD
```

作業説明は `--session <file>` で指定します。[サンプル JSON](examples/session.example.json) を参照してください。
`--port`、`--no-open`、`--live`、`--detach`、`--no-wake` も使用できます。`--base` の既定値は `HEAD` です。
手動ライブモードは `diffchecker open --live --detach --repo .` で開始し、
`diffchecker wait --repo .` で質問を受信します。回答文を標準入力で
`diffchecker answer --id <id> --repo .` に渡し、`closed` または `gone` まで繰り返します。
修正後は `diffchecker refresh --repo .` または `answer --changed <file>` で更新します。
詳しい操作は [codediff-show](skill/SKILL.md) を参照してください。

ライブモード以外では、ご自身のチャットプロバイダーを設定します。

| 種類 | 設定 |
| --- | --- |
| 標準入力を読む CLI | `--chat-cmd "<command>"` または `chat.command` |
| OpenAI 互換エンドポイント | `--chat-url <url> --chat-model <model>` または `chat.url` / `chat.model` |

CLI の指定はセッション設定より優先されます。キーは `CODEDIFF_CHAT_API_KEY` または
`chat.apiKeyEnv` で指定した環境変数から読み込みます。セッションに認証情報を書き込まないでください。
プロバイダー未設定では単独のチャット機能は利用できません。

## プライバシーとオフライン動作

状態、回答、ログは対象リポジトリー内の、自動的に Git の対象外となる `.codediff/` に保存します。
ライブの質問はエージェントへ渡され、そのプロバイダーのポリシーが適用されます。
外部のチャットエンドポイントや CLI を設定した場合、関連する作業情報と差分が送信されます。
外部 AI 利用時にソースが必ず端末内に留まるとは想定しないでください。
Monaco は固定バージョンの jsDelivr アセットを読み込み、接続できない場合は統合差分へ切り替わります。
ローカル描画であっても、エディターを含む完全なオフラインパッケージではありません。

## 更新とアンインストール

更新時は GitHub からのインストールコマンドを再実行します。ローカル版は新しい tarball を作成して再インストールします。
`diffchecker doctor` と
`diffchecker setup --dry-run` を確認してからセットアップします。
変更されたスキルは前述の競合を手動で解消してください。バックグラウンド更新はありません。

```sh
npm uninstall --global @mirko87-stack/diffchecker
```

npm のコマンドは削除されますが、スキルとレビューデータは残ります。
各保存先で、ご自身が導入した `codediff-show` だけを確認して削除し、独自の変更は先にバックアップしてください。
既存の `.codediff/` セッションを保持するか削除するかは利用者が判断します。

## 開発

```sh
npm test
node bin/codediff.js doctor
npm start
```

npm の依存パッケージやビルド処理は不要です。開発メモ、タスク管理ファイル、ローカルのエージェント指示は、
公開用スナップショットと npm パッケージから除外します。

ローカルのチェックアウトからは、そのディレクトリーで `npm pack` を実行し、
`npm install --global ./mirko87-stack-diffchecker-0.1.0.tgz` で導入できます。
バージョン変更時は `npm pack` が表示するファイル名を使用してください。

## ライセンスと公開状況

公開 GitHub リポジトリーで選択済みの [MIT ライセンス](LICENSE) を適用します。
npm レジストリーのリリースではなく、ソースリポジトリーからインストールします。
macOS / Linux の実機検証も未完了です。
