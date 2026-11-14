const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!NOTION_API_KEY || !NOTION_DATA_SOURCE_ID || !SLACK_WEBHOOK_URL) {
  throw new Error(
    "NOTION_API_KEY / NOTION_DATA_SOURCE_ID / SLACK_WEBHOOK_URL が設定されていません",
  );
}

const NOTION_VERSION = "2026-03-11";
const STATUS_PROPERTY = "ステータス";
const DATE_PROPERTY = "実行日";
const TITLE_PROPERTY = "タイトル";

function todayInJst() {
  // "en-CA" ロケールは YYYY-MM-DD 形式で返す
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

async function fetchTargetTasks(today) {
  const res = await fetch(
    `https://api.notion.com/v1/data_sources/${NOTION_DATA_SOURCE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          and: [
            { property: STATUS_PROPERTY, status: { does_not_equal: "Done" } },
            { property: DATE_PROPERTY, date: { on_or_before: today } },
          ],
        },
        sorts: [{ property: DATE_PROPERTY, direction: "ascending" }],
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
  }

  const { results } = await res.json();
  return results;
}

function extractTitle(page) {
  const titleProp = page.properties[TITLE_PROPERTY];
  const text = titleProp?.title?.map((t) => t.plain_text).join("");
  return text || "(無題)";
}

function extractDate(page) {
  return page.properties[DATE_PROPERTY]?.date?.start?.slice(0, 10);
}

function extractStatus(page) {
  return page.properties[STATUS_PROPERTY]?.status?.name;
}

// 実行日が今日より前（期限切れ）/ 今日（ステータスごと）に分類する
function groupTasks(tasks, today) {
  const overdue = [];
  const todayToDo = [];
  const todayInProgress = [];

  for (const page of tasks) {
    if (extractDate(page) < today) {
      overdue.push(page);
    } else if (extractStatus(page) === "InProgress") {
      todayInProgress.push(page);
    } else {
      todayToDo.push(page);
    }
  }

  return { overdue, todayToDo, todayInProgress };
}

function bulletLines(tasks) {
  return tasks.map((page) => `• <${page.url}|${extractTitle(page)}>`).join("\n");
}

function section(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function buildSlackMessage({ overdue, todayToDo, todayInProgress }) {
  const blocks = [];
  const hasToday = todayToDo.length > 0 || todayInProgress.length > 0;

  if (overdue.length > 0) {
    blocks.push(section(`🚨 *やり残し（期限切れ）*\n${bulletLines(overdue)}`));
  }

  if (overdue.length > 0 && hasToday) {
    blocks.push({ type: "divider" });
  }

  if (hasToday) {
    blocks.push(section("📋 *今日のタスク*"));
    if (todayInProgress.length > 0) {
      blocks.push(section(`▶️ *進行中*\n${bulletLines(todayInProgress)}`));
    }
    if (todayToDo.length > 0) {
      blocks.push(section(`⬜ *未着手*\n${bulletLines(todayToDo)}`));
    }
  }

  const text = `やり残し ${overdue.length}件 / 今日 ${todayToDo.length + todayInProgress.length}件`;
  return { text, blocks };
}

async function postToSlack(message) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook error: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const today = todayInJst();
  const tasks = await fetchTargetTasks(today);

  if (tasks.length === 0) {
    console.log("対象タスクなし。通知をスキップします。");
    return;
  }

  const grouped = groupTasks(tasks, today);
  await postToSlack(buildSlackMessage(grouped));
  console.log(`${tasks.length}件のタスクをSlackに通知しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
