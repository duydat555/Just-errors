import {
  DEFAULT_PRICING,
  getSettings,
  getUsageStats,
  saveSettings
} from "./lib/settings.js";

const enabledToggle = document.getElementById("enabled-toggle");
const modeButtons = document.querySelectorAll(".seg-btn");
const providerSelect = document.getElementById("provider-select");
const modelBadge = document.getElementById("model-badge");
const keyWarning = document.getElementById("key-warning");
const budgetWarning = document.getElementById("budget-warning");
const usageCallsEl = document.getElementById("usage-calls");
const usageTokensEl = document.getElementById("usage-tokens");
const usageReasoningEl = document.getElementById("usage-reasoning");
const usageCostEl = document.getElementById("usage-cost");
const usageAvgCostEl = document.getElementById("usage-avg-cost");
const openOptionsBtn = document.getElementById("open-options-btn");

function formatUsd(val) {
  const num = Number(val || 0);
  return `$${num.toFixed(4)}`;
}

/**
 * Tính chi phí trung bình mỗi lần gọi API thật (không tính các lần trả về từ cache).
 */
export function computeAverageCostPerRealCall(today = {}, total = {}) {
  const todayRealCalls = Number(today.calls || 0);
  if (todayRealCalls > 0) {
    return Number(today.estimatedCostUsd || 0) / todayRealCalls;
  }
  const totalRealCalls = Number(total.calls || 0);
  if (totalRealCalls > 0) {
    return Number(total.estimatedCostUsd || 0) / totalRealCalls;
  }
  return 0;
}

function renderUI(settings, usageStats) {
  enabledToggle.checked = Boolean(settings.enabled);

  modeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === settings.mode);
  });

  providerSelect.value = settings.provider;

  const pCfg = settings.providers[settings.provider] || {};
  const activeModel =
    settings.mode === "accurate" ? pCfg.accurateModel : pCfg.fastModel;

  const lastMeta = settings.lastSolveMeta;
  if (lastMeta && lastMeta.model) {
    const pName = lastMeta.providerName ? `${lastMeta.providerName}/` : "";
    const fbTag = lastMeta.usedCrossProvider
      ? " (dự phòng chéo)"
      : lastMeta.usedFallback
        ? " (dự phòng)"
        : "";
    const reqTag =
      typeof lastMeta.totalRequests === "number" ? `, ${lastMeta.totalRequests} req` : "";
    modelBadge.textContent = `Đang chọn: ${activeModel || ""} · Vừa trả lời: ${pName}${lastMeta.model}${fbTag}${reqTag}`;
    modelBadge.title = modelBadge.textContent;
  } else {
    modelBadge.textContent = `Model: ${activeModel || ""}`;
    modelBadge.title = modelBadge.textContent;
  }

  const hasKey = Boolean(pCfg.apiKey && pCfg.apiKey.trim());
  keyWarning.classList.toggle("hidden", hasKey);

  if (usageStats) {
    const today = usageStats.today || {};
    const total = usageStats.total || {};
    const realCallsToday = Number(today.calls || 0);
    const cacheHitsToday = Number(today.cacheHits || 0);

    usageCallsEl.textContent = `${realCallsToday} lần gọi (${cacheHitsToday} cache)`;

    const cacheNote =
      today.cachedTokens > 0 ? ` (cache: ${today.cachedTokens})` : "";
    usageTokensEl.textContent = `${today.inputTokens || 0} / ${today.outputTokens || 0}${cacheNote}`;

    if (usageReasoningEl) {
      const todayReasoning = Number(today.reasoningTokens || 0);
      const totalReasoning = Number(total.reasoningTokens || 0);
      usageReasoningEl.textContent =
        totalReasoning > todayReasoning
          ? `${todayReasoning} (Tổng: ${totalReasoning})`
          : `${todayReasoning}`;
    }

    usageCostEl.textContent = `${formatUsd(today.estimatedCostUsd)} (Tổng: ${formatUsd(total.estimatedCostUsd)})`;

    if (usageAvgCostEl) {
      const avgCost = computeAverageCostPerRealCall(today, total);
      usageAvgCostEl.textContent =
        realCallsToday > 0 || Number(total.calls || 0) > 0
          ? `${formatUsd(avgCost)} / lần`
          : "$0.0000 / lần";
    }

    const alertThreshold =
      settings.pricing?.budgetAlertUsd ?? DEFAULT_PRICING.budgetAlertUsd;
    const currentTotalCost = Number(total.estimatedCostUsd || 0);
    const currentTodayCost = Number(today.estimatedCostUsd || 0);
    const maxCost = Math.max(currentTotalCost, currentTodayCost);

    if (alertThreshold > 0 && maxCost >= alertThreshold) {
      budgetWarning.classList.remove("hidden");
      budgetWarning.textContent = `⚠️ Chi phí ước tính (${formatUsd(maxCost)}) đã vượt ngưỡng cảnh báo ($${Number(alertThreshold).toFixed(2)}).`;
    } else {
      budgetWarning.classList.add("hidden");
    }
  }
}

async function init() {
  const [settings, usageStats] = await Promise.all([
    getSettings(),
    getUsageStats()
  ]);
  renderUI(settings, usageStats);
}

enabledToggle.addEventListener("change", async () => {
  const [next, usageStats] = await Promise.all([
    saveSettings({ enabled: enabledToggle.checked }),
    getUsageStats()
  ]);
  renderUI(next, usageStats);
});

modeButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode === "accurate" ? "accurate" : "fast";
    const [next, usageStats] = await Promise.all([
      saveSettings({ mode }),
      getUsageStats()
    ]);
    renderUI(next, usageStats);
  });
});

providerSelect.addEventListener("change", async () => {
  const [next, usageStats] = await Promise.all([
    saveSettings({ provider: providerSelect.value }),
    getUsageStats()
  ]);
  renderUI(next, usageStats);
});

openOptionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

init();
