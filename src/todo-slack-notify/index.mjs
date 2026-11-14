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

function buildSlackMessage(tasks) {
  const lines = tasks.map((page) => `• <${page.url}|${extractTitle(page)}>`);
  return { text: lines.join("\n") };
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

  await postToSlack(buildSlackMessage(tasks));
  console.log(`${tasks.length}件のタスクをSlackに通知しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
