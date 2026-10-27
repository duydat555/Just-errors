import {
  DEFAULT_PRICING,
  PROVIDER_META,
  getSettings,
  getUsageStats,
  normalizeProviderOrder,
  resetUsageStats,
  saveSettings
} from "./lib/settings.js";
import {
  formatDiagnosticsSummary,
  probeProviderModel,
  testProviderKeyOnly
} from "./providers/index.js";

const providerNotes = {
  anthropic: "Gọi trực tiếp https://api.anthropic.com/v1/messages (hỗ trợ Vision + Adaptive Thinking + Prompt Caching).",
  openai: "Gọi trực tiếp https://api.openai.com/v1/chat/completions (hỗ trợ Vision + Reasoning Effort).",
  gemini: "Gọi trực tiếp https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent. (Lưu ý: gói Free tier có hạn mức RPM/RPD thấp, khuyến nghị bật Billing trong Google AI Studio).",
  deepseek: "Model deepseek-flash hỗ trợ cả ảnh (Vision) và bật/tắt Thinking. Model deepseek-v4-pro chỉ nhận văn bản (dùng khi bật trích xuất DOM)."
};

const providersListEl = document.getElementById("providers-list");
const providerSelectEl = document.getElementById("provider-select");
const modeSelectEl = document.getElementById("mode-select");
const enableFallbackEl = document.getElementById("enable-fallback");
const enableCrossFallbackEl = document.getElementById("enable-cross-fallback");
const crossProviderOrderEl = document.getElementById("cross-provider-order");
const majorityVoteEl = document.getElementById("majority-vote");
const preferDomEl = document.getElementById("prefer-dom");
const customPromptEl = document.getElementById("custom-prompt");
const priceInputEl = document.getElementById("price-input");
const priceOutputEl = document.getElementById("price-output");
const budgetAlertEl = document.getElementById("budget-alert");
const optionsUsageSummaryEl = document.getElementById("options-usage-summary");
const resetUsageBtn = document.getElementById("reset-usage-btn");
const saveStatusEl = document.getElementById("save-status");
const saveBtn = document.getElementById("save-btn");
const resetDefaultsBtn = document.getElementById("reset-defaults-btn");
const copyShortcutsBtn = document.getElementById("copy-shortcuts-btn");
const shortcutsUrlEl = document.getElementById("shortcuts-url");

function showSaveBanner(text) {
  saveStatusEl.textContent = text;
  setTimeout(() => {
    if (saveStatusEl.textContent === text) {
      saveStatusEl.textContent = "";
    }
  }, 3000);
}

function renderUsageSummary(stats) {
  if (!optionsUsageSummaryEl || !stats) return;
  const t = stats.today || {};
  const tot = stats.total || {};
  const realCalls = Number(t.calls || 0);
  const avgUsd = realCalls > 0 ? Number(t.estimatedCostUsd || 0) / realCalls : 0;
  optionsUsageSummaryEl.textContent =
    `Hôm nay (${stats.todayKey}): ${realCalls} lần gọi thật, ${t.cacheHits || 0} lần dùng lại cache · ` +
    `Token vào/ra: ${t.inputTokens || 0}/${t.outputTokens || 0} (suy luận: ${t.reasoningTokens || 0}, cache: ${t.cachedTokens || 0}) · ` +
    `Ước tính hôm nay: $${Number(t.estimatedCostUsd || 0).toFixed(4)} (TB: $${avgUsd.toFixed(4)}/lần) | Tổng tích lũy: $${Number(tot.estimatedCostUsd || 0).toFixed(4)}`;
}

function renderTestStatus(container, { state, message, diagnostics, onRetry }) {
  container.className = `test-status ${state || ""}`.trim();
  container.innerHTML = "";

  const row = document.createElement("div");
  row.className = "test-status-row";

  const textSpan = document.createElement("span");
  textSpan.textContent = message;
  row.appendChild(textSpan);

  if ((state === "warn" || state === "err") && typeof onRetry === "function") {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "btn-inline-retry";
    retryBtn.textContent = "Thử lại";
    retryBtn.addEventListener("click", onRetry);
    row.appendChild(retryBtn);
  }

  container.appendChild(row);

  const traceStr = formatDiagnosticsSummary(diagnostics);
  if (traceStr) {
    const traceEl = document.createElement("div");
    traceEl.className = "test-status-trace";
    traceEl.textContent = `Nhật ký: ${traceStr}`;
    container.appendChild(traceEl);
  }
}

function renderProviders(settings) {
  providersListEl.innerHTML = "";

  for (const [id, meta] of Object.entries(PROVIDER_META)) {
    const pCfg = settings.providers[id] || {
      apiKey: "",
      fastModel: meta.defaultFastModel,
      accurateModel: meta.defaultAccurateModel,
      fallbackModel: meta.defaultFallbackModel
    };

    const box = document.createElement("div");
    box.className = "provider-box";
    box.dataset.provider = id;

    box.innerHTML = `
      <div class="provider-header">
        <span class="provider-title">${meta.name}</span>
        <div class="provider-btn-group">
          <button type="button" class="btn-secondary test-key-btn" data-provider="${id}" title="Chỉ gọi GET /models, không tốn quota generateContent">Kiểm tra key</button>
          <button type="button" class="btn-secondary probe-model-btn" data-provider="${id}" title="Gửi 1 yêu cầu ngắn tới fastModel để thử phản hồi thực tế">Thử model</button>
        </div>
      </div>
      <div class="provider-note">${providerNotes[id] || ""}</div>
      <div class="key-input-group">
        <input
          type="password"
          class="api-key-input"
          data-provider="${id}"
          placeholder="Nhập API key cho ${meta.name}..."
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="btn-secondary toggle-key-btn" data-provider="${id}">Hiện</button>
      </div>
      <div class="models-grid">
        <div class="model-field">
          <label>Model Nhanh (fastModel)</label>
          <input
            type="text"
            class="fast-model-input"
            data-provider="${id}"
            placeholder="${meta.defaultFastModel}"
            spellcheck="false"
          />
        </div>
        <div class="model-field">
          <label>Model Chính xác (accurateModel)</label>
          <input
            type="text"
            class="accurate-model-input"
            data-provider="${id}"
            placeholder="${meta.defaultAccurateModel}"
            spellcheck="false"
          />
        </div>
        <div class="model-field">
          <label>Model dự phòng 429/503 (fallbackModel)</label>
          <input
            type="text"
            class="fallback-model-input"
            data-provider="${id}"
            placeholder="Để trống nếu tắt"
            spellcheck="false"
          />
        </div>
      </div>
      <div class="test-status" data-status-for="${id}"></div>
    `;

    const keyInput = box.querySelector(".api-key-input");
    const fastInput = box.querySelector(".fast-model-input");
    const accurateInput = box.querySelector(".accurate-model-input");
    const fallbackInput = box.querySelector(".fallback-model-input");
    const toggleBtn = box.querySelector(".toggle-key-btn");
    const testKeyBtn = box.querySelector(".test-key-btn");
    const probeModelBtn = box.querySelector(".probe-model-btn");
    const testStatus = box.querySelector(".test-status");

    keyInput.value = pCfg.apiKey || "";
    fastInput.value = pCfg.fastModel || meta.defaultFastModel;
    accurateInput.value = pCfg.accurateModel || meta.defaultAccurateModel;
    fallbackInput.value =
      typeof pCfg.fallbackModel === "string" ? pCfg.fallbackModel : meta.defaultFallbackModel;

    toggleBtn.addEventListener("click", () => {
      const isPassword = keyInput.type === "password";
      keyInput.type = isPassword ? "text" : "password";
      toggleBtn.textContent = isPassword ? "Ẩn" : "Hiện";
    });

    const runKeyOnlyCheck = async () => {
      const currentKey = keyInput.value.trim();
      const fastModel = fastInput.value.trim() || meta.defaultFastModel;
      const accurateModel = accurateInput.value.trim() || meta.defaultAccurateModel;
      const fallbackModel = fallbackInput.value.trim();

      if (!currentKey) {
        renderTestStatus(testStatus, {
          state: "err",
          message: "Chưa nhập API key.",
          diagnostics: []
        });
        return;
      }

      testKeyBtn.disabled = true;
      probeModelBtn.disabled = true;
      testStatus.className = "test-status";
      testStatus.textContent = "Đang kiểm tra key & đối chiếu danh sách model…";

      try {
        await saveSettings(collectFormSettings());

        const res = await testProviderKeyOnly({
          providerId: id,
          apiKey: currentKey,
          fastModel,
          accurateModel,
          fallbackModel,
          timeoutMs: 10000
        });

        renderTestStatus(testStatus, {
          state: res.state || "ok",
          message: res.message,
          diagnostics: res.diagnostics,
          onRetry: runKeyOnlyCheck
        });
      } catch (err) {
        renderTestStatus(testStatus, {
          state: "err",
          message: err?.message || "Kiểm tra key thất bại",
          diagnostics: err?.diagnostics || [],
          onRetry: runKeyOnlyCheck
        });
      } finally {
        testKeyBtn.disabled = false;
        probeModelBtn.disabled = false;
      }
    };

    const runModelProbe = async () => {
      const currentKey = keyInput.value.trim();
      const fastModel = fastInput.value.trim() || meta.defaultFastModel;

      if (!currentKey) {
        renderTestStatus(testStatus, {
          state: "err",
          message: "Chưa nhập API key.",
          diagnostics: []
        });
        return;
      }

      testKeyBtn.disabled = true;
      probeModelBtn.disabled = true;
      testStatus.className = "test-status";
      testStatus.textContent = `Đang thử gọi model "${fastModel}"…`;

      try {
        await saveSettings(collectFormSettings());

        const res = await probeProviderModel({
          providerId: id,
          apiKey: currentKey,
          model: fastModel,
          timeoutMs: 10000
        });

        renderTestStatus(testStatus, {
          state: res.state || "ok",
          message: res.message,
          diagnostics: res.diagnostics,
          onRetry: runModelProbe
        });
      } catch (err) {
        renderTestStatus(testStatus, {
          state: "err",
          message: err?.message || "Thử model thất bại",
          diagnostics: err?.diagnostics || [],
          onRetry: runModelProbe
        });
      } finally {
        testKeyBtn.disabled = false;
        probeModelBtn.disabled = false;
      }
    };

    testKeyBtn.addEventListener("click", runKeyOnlyCheck);
    probeModelBtn.addEventListener("click", runModelProbe);
    providersListEl.appendChild(box);
  }
}

function collectFormSettings() {
  const providers = {};
  for (const [id, meta] of Object.entries(PROVIDER_META)) {
    const box = providersListEl.querySelector(`.provider-box[data-provider="${id}"]`);
    if (!box) continue;
    const apiKey = box.querySelector(".api-key-input").value.trim();
    const fastModel = box.querySelector(".fast-model-input").value.trim() || meta.defaultFastModel;
    const accurateModel =
      box.querySelector(".accurate-model-input").value.trim() || meta.defaultAccurateModel;
    const fallbackModel = box.querySelector(".fallback-model-input").value.trim();
    providers[id] = { apiKey, fastModel, accurateModel, fallbackModel };
  }

  return {
    provider: providerSelectEl.value,
    mode: modeSelectEl.value,
    enableModelFallback: enableFallbackEl.checked,
    enableCrossProviderFallback: enableCrossFallbackEl.checked,
    crossProviderOrder: normalizeProviderOrder(crossProviderOrderEl.value),
    accurateMajorityVote: majorityVoteEl.checked,
    preferDomExtraction: preferDomEl.checked,
    pricing: {
      inputPricePerMillion: Number.parseFloat(priceInputEl.value),
      outputPricePerMillion: Number.parseFloat(priceOutputEl.value),
      budgetAlertUsd: Number.parseFloat(budgetAlertEl.value)
    },
    customPrompt: customPromptEl.value.trim(),
    providers
  };
}

async function validateConfiguredModelsOnSave(updatedSettings) {
  for (const [id, pCfg] of Object.entries(updatedSettings.providers || {})) {
    if (!pCfg || !pCfg.apiKey) continue;
    const box = providersListEl.querySelector(`.provider-box[data-provider="${id}"]`);
    if (!box) continue;
    const testStatus = box.querySelector(".test-status");
    try {
      const res = await testProviderKeyOnly({
        providerId: id,
        apiKey: pCfg.apiKey,
        fastModel: pCfg.fastModel,
        accurateModel: pCfg.accurateModel,
        fallbackModel: pCfg.fallbackModel,
        timeoutMs: 8000
      });
      renderTestStatus(testStatus, {
        state: res.state || "ok",
        message: res.message,
        diagnostics: res.diagnostics
      });
    } catch (err) {
      renderTestStatus(testStatus, {
        state: "err",
        message: err?.message || "Không thể đối chiếu danh sách model",
        diagnostics: err?.diagnostics || []
      });
    }
  }
}

async function init() {
  const [settings, usageStats] = await Promise.all([
    getSettings(),
    getUsageStats()
  ]);
  providerSelectEl.value = settings.provider;
  modeSelectEl.value = settings.mode;
  enableFallbackEl.checked = settings.enableModelFallback !== false;
  enableCrossFallbackEl.checked = Boolean(settings.enableCrossProviderFallback);
  crossProviderOrderEl.value = (settings.crossProviderOrder || []).join(", ");
  majorityVoteEl.checked = Boolean(settings.accurateMajorityVote);
  preferDomEl.checked = Boolean(settings.preferDomExtraction);
  priceInputEl.value = String(
    settings.pricing?.inputPricePerMillion ?? DEFAULT_PRICING.inputPricePerMillion
  );
  priceOutputEl.value = String(
    settings.pricing?.outputPricePerMillion ?? DEFAULT_PRICING.outputPricePerMillion
  );
  budgetAlertEl.value = String(
    settings.pricing?.budgetAlertUsd ?? DEFAULT_PRICING.budgetAlertUsd
  );
  customPromptEl.value = settings.customPrompt || "";
  renderUsageSummary(usageStats);
  renderProviders(settings);
}

saveBtn.addEventListener("click", async () => {
  const updated = collectFormSettings();
  crossProviderOrderEl.value = updated.crossProviderOrder.join(", ");
  await saveSettings(updated);
  showSaveBanner("Đã lưu cấu hình & đang đối chiếu model…");
  await validateConfiguredModelsOnSave(updated);
  showSaveBanner("Đã lưu cấu hình");
});

for (const el of [
  providerSelectEl,
  modeSelectEl,
  enableFallbackEl,
  enableCrossFallbackEl,
  majorityVoteEl,
  preferDomEl,
  priceInputEl,
  priceOutputEl,
  budgetAlertEl
]) {
  el.addEventListener("change", async () => {
    await saveSettings(collectFormSettings());
    showSaveBanner("Đã tự động lưu");
  });
}

resetUsageBtn.addEventListener("click", async () => {
  const stats = await resetUsageStats();
  renderUsageSummary(stats);
  showSaveBanner("Đã đặt lại bộ đếm chi tiêu");
});

resetDefaultsBtn.addEventListener("click", async () => {
  for (const [id, meta] of Object.entries(PROVIDER_META)) {
    const box = providersListEl.querySelector(`.provider-box[data-provider="${id}"]`);
    if (!box) continue;
    box.querySelector(".fast-model-input").value = meta.defaultFastModel;
    box.querySelector(".accurate-model-input").value = meta.defaultAccurateModel;
    box.querySelector(".fallback-model-input").value = meta.defaultFallbackModel;
  }
  priceInputEl.value = String(DEFAULT_PRICING.inputPricePerMillion);
  priceOutputEl.value = String(DEFAULT_PRICING.outputPricePerMillion);
  budgetAlertEl.value = String(DEFAULT_PRICING.budgetAlertUsd);
  await saveSettings(collectFormSettings());
  showSaveBanner("Đã khôi phục cấu hình mặc định");
});

copyShortcutsBtn.addEventListener("click", async () => {
  const url = shortcutsUrlEl.textContent.trim();
  try {
    await navigator.clipboard.writeText(url);
    copyShortcutsBtn.textContent = "Đã sao chép!";
    setTimeout(() => {
      copyShortcutsBtn.textContent = "Sao chép địa chỉ";
    }, 1800);
  } catch (_) {}
});

init();
