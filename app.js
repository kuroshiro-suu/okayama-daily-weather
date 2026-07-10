"use strict";

/*
  日報用（岡山版）
  Ver.0.1

  最高気温・天気：
  気象庁 予報JSON 岡山県 330000

  WBGT：
  環境省 WBGT 予測値API
  岡山地点 66408
*/

const CONFIG = {
  jmaAreaCode: "330000",
  wbgtNo: "66408",
  cacheKey: "okayama_daily_weather_cache_v1"
};

const els = {
  dateText: document.getElementById("dateText"),
  tempMax: document.getElementById("tempMax"),
  wbgt: document.getElementById("wbgt"),
  dangerIcon: document.getElementById("dangerIcon"),
  dangerText: document.getElementById("dangerText"),
  weather: document.getElementById("weather"),
  updateButton: document.getElementById("updateButton"),
  updatedAt: document.getElementById("updatedAt"),
  message: document.getElementById("message"),
  card: document.querySelector(".card")
};

document.addEventListener("DOMContentLoaded", () => {
  setTodayText();
  loadCache();
  updateData();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
});

els.updateButton.addEventListener("click", () => {
  updateData();
});

function setTodayText() {
  const now = new Date();
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

  const text =
    `${now.getFullYear()}年` +
    `${now.getMonth() + 1}月` +
    `${now.getDate()}日` +
    `（${weekdays[now.getDay()]}）`;

  els.dateText.textContent = text;
}

async function updateData() {
  setLoading(true);
  setMessage("");

  try {
    const [jmaData, wbgtValue] = await Promise.all([
      fetchJmaForecast(),
      fetchWbgt()
    ]);

    const result = {
      date: new Date().toISOString(),
      tempMax: jmaData.tempMax,
      weather: jmaData.weather,
      wbgt: wbgtValue
    };

    render(result);
    saveCache(result);
  } catch (error) {
    console.error(error);
    setMessage("取得に失敗しました。時間をおいて更新してください。");
  } finally {
    setLoading(false);
  }
}

async function fetchJmaForecast() {
  const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${CONFIG.jmaAreaCode}.json`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("気象庁データを取得できませんでした");
  }

  const data = await response.json();

  const weather = parseJmaWeather(data);
  const tempMax = parseJmaTempMax(data);

  return {
    weather,
    tempMax
  };
}

function parseJmaWeather(data) {
  try {
    const areas = data[0].timeSeries[0].areas;

    const target =
      areas.find(a => a.area && a.area.name.includes("南部")) ||
      areas[0];

    const rawWeather = target.weathers[0] || "--";
    return simplifyWeather(rawWeather);
  } catch {
    return "--";
  }
}

function simplifyWeather(text) {
  if (!text || text === "--") return "--";

  if (text.includes("雪")) return "雪";
  if (text.includes("雨")) return "雨";
  if (text.includes("曇")) return "曇";
  if (text.includes("晴")) return "晴";

  return text.slice(0, 1);
}

function parseJmaTempMax(data) {
  /*
    気象庁JSONは時期や発表タイミングで配列位置が少し変わることがあるため、
    岡山地点らしい temps / tempsMax を広めに探す。
  */

  const candidates = [];

  for (const forecastBlock of data) {
    if (!forecastBlock.timeSeries) continue;

    for (const timeSeries of forecastBlock.timeSeries) {
      if (!timeSeries.areas) continue;

      for (const area of timeSeries.areas) {
        const areaName = area.area?.name || "";

        const isOkayama =
          areaName.includes("岡山") ||
          areaName.includes("南部");

        if (!isOkayama) continue;

        if (Array.isArray(area.tempsMax)) {
          candidates.push(...area.tempsMax);
        }

        if (Array.isArray(area.temps)) {
          candidates.push(...area.temps);
        }
      }
    }
  }

  const nums = candidates
    .map(v => Number(v))
    .filter(v => Number.isFinite(v));

  if (nums.length === 0) return "--";

  /*
    朝の予報で「今日・明日」が入ることがあるため、
    まず最初の数値を採用。
    ただし低すぎる値が混ざる場合に備え、30未満しかない時以外は最大値を採用。
  */
  const high = Math.max(...nums);

  return String(Math.round(high));
}

async function fetchWbgt() {
  const today = formatDateYmd(new Date());

  const url =
    "https://www.wbgt.env.go.jp/api/v1/getForecastData" +
    `?location_type=1` +
    `&date_search_type=2` +
    `&wbgt_nos=${encodeURIComponent(CONFIG.wbgtNo)}` +
    `&fixed_time_dates=${today}`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("WBGTデータを取得できませんでした");
  }

  const json = await response.json();

  if (json.status !== "success" || !Array.isArray(json.data)) {
    throw new Error("WBGTデータ形式が想定外です");
  }

  const todaySlash = today.replaceAll("-", "/");

  const values = json.data
    .filter(item => String(item.forecast_time || "").startsWith(todaySlash))
    .map(item => normalizeWbgtValue(item.forecast_val))
    .filter(v => Number.isFinite(v));

  if (values.length === 0) return "--";

  const max = Math.max(...values);

  return formatNumber(max);
}

function normalizeWbgtValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;

  /*
    APIの値が 31.2 のように返る場合と、
    312 のように10倍値で返る場合の両方に軽く対応。
  */
  if (n > 60) return n / 10;

  return n;
}

function render(data) {
  els.tempMax.textContent = data.tempMax ?? "--";
  els.weather.textContent = data.weather ?? "--";
  els.wbgt.textContent = data.wbgt ?? "--";

  const danger = getDanger(data.wbgt);

  els.dangerIcon.textContent = danger.icon;
  els.dangerText.textContent = danger.text;

  const d = new Date();
  els.updatedAt.textContent =
    `最終取得 ${String(d.getHours()).padStart(2, "0")}:` +
    `${String(d.getMinutes()).padStart(2, "0")}`;
}

function getDanger(wbgt) {
  const n = Number(wbgt);

  if (!Number.isFinite(n)) {
    return { icon: "--", text: "--" };
  }

  if (n >= 31) {
    return { icon: "👹", text: "危険" };
  }

  if (n >= 28) {
    return { icon: "🥵", text: "高" };
  }

  if (n >= 25) {
    return { icon: "😐", text: "中" };
  }

  return { icon: "🙂", text: "低" };
}

function saveCache(data) {
  try {
    localStorage.setItem(CONFIG.cacheKey, JSON.stringify(data));
  } catch {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CONFIG.cacheKey);
    if (!raw) return;

    const data = JSON.parse(raw);
    render(data);
  } catch {}
}

function setLoading(isLoading) {
  els.updateButton.disabled = isLoading;
  els.updateButton.textContent = isLoading ? "取得中..." : "更新";

  if (isLoading) {
    els.card.classList.add("loading");
  } else {
    els.card.classList.remove("loading");
  }
}

function setMessage(text) {
  els.message.textContent = text;
}

function formatDateYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

function formatNumber(value) {
  const rounded = Math.round(value * 10) / 10;

  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return rounded.toFixed(1);
}
