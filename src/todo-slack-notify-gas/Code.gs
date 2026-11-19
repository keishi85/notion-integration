// Notion Todo → Slack 通知（Google Apps Script 版）
// index.mjs の移植。GitHub Actions の schedule は数時間遅れることがあるため、GAS の時間トリガーで動かす。
//
// 事前準備: プロジェクトの設定 → スクリプト プロパティ に以下を登録する
//   NOTION_API_KEY / NOTION_DATA_SOURCE_ID / SLACK_WEBHOOK_URL
// タイムゾーンは appsscript.json で "Asia/Tokyo" にしておく（トリガー時刻・日付判定がJSTになる）。

const NOTION_VERSION = "2026-03-11";
const STATUS_PROPERTY = "ステータス";
const DATE_PROPERTY = "実行日";
const TITLE_PROPERTY = "タイトル";
const GTD_TYPE_PROPERTY = "GTD 種別";
// 「いつかやる・たぶんやる」「ゴミ箱」は今日やるべきタスクではないため通知対象から除外する
const EXCLUDED_GTD_TYPES = ["💫 いつかやる・たぶんやる", "🗑 ゴミ箱"];
const TZ = "Asia/Tokyo";
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const config = {
    notionApiKey: props.getProperty("NOTION_API_KEY"),
    dataSourceId: props.getProperty("NOTION_DATA_SOURCE_ID"),
    slackWebhookUrl: props.getProperty("SLACK_WEBHOOK_URL"),
  };
  if (!config.notionApiKey || !config.dataSourceId || !config.slackWebhookUrl) {
    throw new Error(
      "NOTION_API_KEY / NOTION_DATA_SOURCE_ID / SLACK_WEBHOOK_URL がスクリプトプロパティに設定されていません",
    );
  }
  return config;
}

function todayInJst_() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function todayLabelJst_() {
  const now = new Date();
  const month = Number(Utilities.formatDate(now, TZ, "M"));
  const day = Number(Utilities.formatDate(now, TZ, "d"));
  const weekday = WEEKDAYS[Number(Utilities.formatDate(now, TZ, "u")) % 7]; // u: 1=月 ... 7=日
  return `${month}月${day}日(${weekday})`;
}

// 未完了タスク(今日以前) に加えて、今日完了したタスクも通知対象に含める(夜の通知で完了分も見たいため)
function buildFilter_(today) {
  const gtdExclusions = EXCLUDED_GTD_TYPES.map((name) => ({
    property: GTD_TYPE_PROPERTY,
    status: { does_not_equal: name },
  }));

  return {
    or: [
      {
        and: [
          { property: STATUS_PROPERTY, status: { does_not_equal: "Done" } },
          { property: DATE_PROPERTY, date: { on_or_before: today } },
          ...gtdExclusions,
        ],
      },
      {
        and: [
          { property: STATUS_PROPERTY, status: { equals: "Done" } },
          { property: DATE_PROPERTY, date: { equals: today } },
          ...gtdExclusions,
        ],
      },
    ],
  };
}

function fetchTargetTasks_(config, today) {
  const res = UrlFetchApp.fetch(
    `https://api.notion.com/v1/data_sources/${config.dataSourceId}/query`,
    {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${config.notionApiKey}`,
        "Notion-Version": NOTION_VERSION,
      },
      payload: JSON.stringify({
        filter: buildFilter_(today),
        sorts: [{ property: DATE_PROPERTY, direction: "ascending" }],
      }),
      muteHttpExceptions: true,
    },
  );

  if (res.getResponseCode() >= 300) {
    throw new Error(`Notion API error: ${res.getResponseCode()} ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText()).results;
}

function extractTitle_(page) {
  const titleProp = page.properties[TITLE_PROPERTY];
  const text = (titleProp && titleProp.title ? titleProp.title : [])
    .map((t) => t.plain_text)
    .join("");
  return text || "(無題)";
}

function extractDate_(page) {
  const date = page.properties[DATE_PROPERTY];
  return date && date.date && date.date.start ? date.date.start.slice(0, 10) : undefined;
}

function extractStatus_(page) {
  const status = page.properties[STATUS_PROPERTY];
  return status && status.status ? status.status.name : undefined;
}

// 実行日が今日より前（期限切れ）/ 今日（ステータスごと、完了含む）に分類する
function groupTasks_(tasks, today) {
  const overdue = [];
  const todayToDo = [];
  const todayInProgress = [];
  const todayDone = [];

  for (const page of tasks) {
    const status = extractStatus_(page);
    if (status === "Done") {
      todayDone.push(page);
    } else if (extractDate_(page) < today) {
      overdue.push(page);
    } else if (status === "InProgress") {
      todayInProgress.push(page);
    } else {
      todayToDo.push(page);
    }
  }

  return { overdue, todayToDo, todayInProgress, todayDone };
}

function bulletLines_(tasks) {
  return tasks.map((page) => `• <${page.url}|${extractTitle_(page)}>`).join("\n");
}

function section_(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function divider_() {
  return { type: "divider" };
}

function buildSlackMessage_({ overdue, todayToDo, todayInProgress, todayDone }) {
  const todayPendingCount = todayToDo.length + todayInProgress.length;
  const hasTodayPending = todayPendingCount > 0;

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `📅 ${todayLabelJst_()} のタスク` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `🚨 やり残し *${overdue.length}件*　・　📋 今日 *${todayPendingCount}件*　・　✅ 完了 *${todayDone.length}件*`,
        },
      ],
    },
    divider_(),
  ];

  if (overdue.length > 0) {
    blocks.push(section_(`🚨 *やり残し（期限切れ）*\n${bulletLines_(overdue)}`));
    if (hasTodayPending || todayDone.length > 0) blocks.push(divider_());
  }

  if (todayToDo.length > 0) {
    blocks.push(section_(`⬜ *未着手* (${todayToDo.length}件)\n${bulletLines_(todayToDo)}`));
  }
  if (todayInProgress.length > 0) {
    blocks.push(section_(`▶️ *進行中* (${todayInProgress.length}件)\n${bulletLines_(todayInProgress)}`));
  }

  if (todayDone.length > 0) {
    if (hasTodayPending) blocks.push(divider_());
    blocks.push(section_(`✅ *完了* (${todayDone.length}件)\n${bulletLines_(todayDone)}`));
  }

  const text = `やり残し ${overdue.length}件 / 今日 ${todayPendingCount}件 / 完了 ${todayDone.length}件`;
  return { text, blocks };
}

function postToSlack_(config, message) {
  const res = UrlFetchApp.fetch(config.slackWebhookUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(message),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() >= 300) {
    throw new Error(`Slack webhook error: ${res.getResponseCode()} ${res.getContentText()}`);
  }
}

// トリガーから呼ばれるエントリポイント（手動実行での動作確認にも使える）
function notifyTodos() {
  const config = getConfig_();
  const today = todayInJst_();
  const tasks = fetchTargetTasks_(config, today);

  if (tasks.length === 0) {
    console.log("対象タスクなし。通知をスキップします。");
    return;
  }

  postToSlack_(config, buildSlackMessage_(groupTasks_(tasks, today)));
  console.log(`${tasks.length}件のタスクをSlackに通知しました。`);
}

// 一度だけ手動実行する: 毎日 9時台 / 20時台 のトリガーを作り直す（実行時刻は各時間帯のどこか）
function setupTriggers() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "notifyTodos") ScriptApp.deleteTrigger(trigger);
  }
  for (const hour of [9, 20]) {
    ScriptApp.newTrigger("notifyTodos").timeBased().everyDays(1).atHour(hour).create();
  }
}
