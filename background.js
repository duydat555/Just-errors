import {
  SCREEN_CACHE_STORAGE_KEY,
  getSettings,
  recordUsageStats,
  saveSettings
} from "./lib/settings.js";
import {
  NO_COMPLETE_MESSAGE,
  formatQuestions,
  mergeMajorityQuestions,
  parseAiResponse
} from "./lib/parse.js";
import { computeContentHash, processScreenshot } from "./lib/image.js";
import {
  getModelCooldownRemainingMs,
  solveWithProviderDetailed,
  summarizeDiagnostics
} from "./providers/index.js";

export const SCREEN_CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút
export const TRIGGER_COOLDOWN_MS = 2000;           // Cooldown ~2 giây giữa hai lần Alt+Q hợp lệ

let activeController = null;
let activeRunId = 0;
let inFlightContext = null; // { runId, tabId, inputHash, controller }
let lastTriggerTimestamp = 0;

// Bộ nhớ cache kết quả theo màn hình (đồng bộ với chrome.storage.session)
const memoryScreenCache = new Map();

export function clearScreenCache() {
  memoryScreenCache.clear();
  lastTriggerTimestamp = 0;
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      chrome.storage.session.remove(SCREEN_CACHE_STORAGE_KEY).catch(() => {});
    }
  } catch (_) {}
}

async function loadScreenCacheFromSession() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const raw = await chrome.storage.session.get(SCREEN_CACHE_STORAGE_KEY);
      const stored = raw ? raw[SCREEN_CACHE_STORAGE_KEY] : null;
      if (stored && typeof stored === "object") {
        const now = Date.now();
        for (const [k, v] of Object.entries(stored)) {
          if (v && typeof v.timestamp === "number" && now - v.timestamp < SCREEN_CACHE_TTL_MS) {
            memoryScreenCache.set(k, v);
          }
        }
      }
    }
  } catch (_) {}
}

async function saveScreenCacheToSession() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const now = Date.now();
      const entries = [];
      for (const [k, v] of memoryScreenCache.entries()) {
        if (v && now - v.timestamp < SCREEN_CACHE_TTL_MS) {
          entries.push([k, v]);
        } else {
          memoryScreenCache.delete(k);
        }
      }
      // Giữ tối đa 40 màn hình gần nhất trong session
      entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
      const trimmed = Object.fromEntries(entries.slice(0, 40));
      await chrome.storage.session.set({ [SCREEN_CACHE_STORAGE_KEY]: trimmed });
    }
  } catch (_) {}
}

function normalizeTabUrlForCache(url = "") {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch (_) {
    return String(url || "");
  }
}

export async function buildScreenCacheKey({
  tabId,
  tabUrl,
  mode,
  providerId,
  model,
  customPrompt,
  contentPayload
}) {
  const inputHash = await computeContentHash(contentPayload || "");
  const normalizedMode = mode === "accurate" ? "accurate" : "fast";
  const normalizedProvider = String(providerId || "").trim().toLowerCase();
  const normalizedModel = String(model || "").trim();
  const promptHash =
    typeof customPrompt === "string" && customPrompt.trim()
      ? await computeContentHash(customPrompt.trim())
      : "default";
  const pageKey = `${tabId || 0}:${normalizeTabUrlForCache(tabUrl)}`;

  // Khóa cache kết hợp đầy đủ: hash nội dung màn hình + chế độ + provider + model + prompt tùy chỉnh (+ tab/trang)
  const cacheKey = [
    inputHash,
    normalizedMode,
    normalizedProvider,
    normalizedModel,
    promptHash,
    pageKey
  ].join("|");

  return {
    inputHash,
    cacheKey
  };
}

export function getCachedScreenResult(cacheKey) {
  if (!cacheKey) return null;
  const entry = memoryScreenCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.timestamp >= SCREEN_CACHE_TTL_MS) {
    memoryScreenCache.delete(cacheKey);
    return null;
  }
  return entry;
}

export async function setCachedScreenResult(cacheKey, value) {
  if (!cacheKey || !value || !value.formatted) return;
  // Không bao giờ lưu cache khi kết quả lỗi hoặc rỗng ("Không thấy câu hoàn chỉnh")
  if (value.formatted === NO_COMPLETE_MESSAGE) return;
  memoryScreenCache.set(cacheKey, {
    ...value,
    timestamp: Date.now()
  });
  await saveScreenCacheToSession();
}

/**
 * Kiểm tra xem URL của tab có bị trình duyệt cấm chèn script hay không.
 */
export function isRestrictedUrl(url) {
  if (!url || typeof url !== "string") return true;
  const lower = url.toLowerCase();
  if (
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("about:") ||
    lower.startsWith("view-source:") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("https://chromewebstore.google.com") ||
    lower.startsWith("https://chrome.google.com/webstore")
  ) {
    return true;
  }
  if (lower.endsWith(".pdf") || lower.includes(".pdf?")) {
    return true;
  }
  return false;
}

async function setErrorBadge(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#000000" });
    await chrome.action.setBadgeText({ tabId, text: "!" });
  } catch (_) {}
}

async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch (_) {}
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (res && res.ok) return true;
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return true;
  } catch (_) {
    return false;
  }
}

export function cancelActiveRequest() {
  activeRunId += 1;
  inFlightContext = null;
  if (activeController) {
    try {
      activeController.abort();
    } catch (_) {}
    activeController = null;
  }
}

function hadRateLimitInDiagnostics(diagnostics = []) {
  return (
    Array.isArray(diagnostics) &&
    diagnostics.some((d) => d && (d.status === 429 || d.skipped))
  );
}

/**
 * Giải 1 lần hoặc chạy 2 lần tuần tự lấy đa số (Yêu cầu 7):
 * - Mặc định tắt (accurateMajorityVote = false).
 * - Chỉ chạy Lần 2 khi người dùng bật VÀ Lần 1 thành công (không lỗi, không dính 429, có câu hợp lệ).
 */
export async function runSolver({
  providerId,
  imageDataUrl,
  mode,
  accurateMajorityVote,
  config,
  signal
}) {
  const shouldRunTwice = mode === "accurate" && Boolean(accurateMajorityVote);
  const sharedDiagnostics = [];

  const runOnce = () =>
    solveWithProviderDetailed({
      providerId,
      imageDataUrl,
      mode,
      config: {
        ...config,
        diagnostics: sharedDiagnostics
      },
      signal
    });

  if (!shouldRunTwice) {
    const detailed = await runOnce();
    const parsed = parseAiResponse(detailed.text);
    const stats = summarizeDiagnostics(sharedDiagnostics);
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.error,
        usedProviderId: detailed.usedProviderId,
        usedProviderName: detailed.usedProviderName,
        usedModel: detailed.usedModel,
        usedFallback: detailed.usedFallback,
        usedCrossProvider: detailed.usedCrossProvider,
        totalRequests: stats.totalRequests,
        byModel: stats.byModel,
        usage: stats.usage,
        diagnostics: sharedDiagnostics
      };
    }
    return {
      ok: true,
      formatted: parsed.formatted,
      usedProviderId: detailed.usedProviderId,
      usedProviderName: detailed.usedProviderName,
      usedModel: detailed.usedModel,
      usedFallback: detailed.usedFallback,
      usedCrossProvider: detailed.usedCrossProvider,
      totalRequests: stats.totalRequests,
      byModel: stats.byModel,
      usage: stats.usage,
      diagnostics: sharedDiagnostics
    };
  }

  // LẦN 1 (tuần tự):
  const run1 = await runOnce();
  const parsed1 = parseAiResponse(run1.text);
  if (!parsed1.ok) {
    const stats = summarizeDiagnostics(sharedDiagnostics);
    return {
      ok: false,
      error: parsed1.error,
      usedProviderId: run1.usedProviderId,
      usedProviderName: run1.usedProviderName,
      usedModel: run1.usedModel,
      usedFallback: run1.usedFallback,
      usedCrossProvider: run1.usedCrossProvider,
      totalRequests: stats.totalRequests,
      byModel: stats.byModel,
      usage: stats.usage,
      diagnostics: sharedDiagnostics
    };
  }

  // Nếu Lần 1 không tìm thấy câu hoàn chỉnh nào hoặc đã dính 429 -> dừng ngay, không chạy Lần 2
  const hit429AfterRun1 =
    hadRateLimitInDiagnostics(sharedDiagnostics) ||
    getModelCooldownRemainingMs(run1.usedProviderId, run1.usedModel) > 0;

  if (
    parsed1.questions.length === 0 ||
    hit429AfterRun1 ||
    signal?.aborted
  ) {
    const stats = summarizeDiagnostics(sharedDiagnostics);
    return {
      ok: true,
      formatted: parsed1.formatted,
      usedProviderId: run1.usedProviderId,
      usedProviderName: run1.usedProviderName,
      usedModel: run1.usedModel,
      usedFallback: run1.usedFallback,
      usedCrossProvider: run1.usedCrossProvider,
      totalRequests: stats.totalRequests,
      byModel: stats.byModel,
      usage: stats.usage,
      diagnostics: sharedDiagnostics
    };
  }

  // LẦN 2 (tuần tự, chỉ khi Lần 1 thành công):
  let run2 = null;
  let parsed2 = null;
  try {
    run2 = await runOnce();
    parsed2 = parseAiResponse(run2.text);
  } catch (_) {
    const stats = summarizeDiagnostics(sharedDiagnostics);
    return {
      ok: true,
      formatted: parsed1.formatted,
      usedProviderId: run1.usedProviderId,
      usedProviderName: run1.usedProviderName,
      usedModel: run1.usedModel,
      usedFallback: run1.usedFallback,
      usedCrossProvider: run1.usedCrossProvider,
      totalRequests: stats.totalRequests,
      byModel: stats.byModel,
      usage: stats.usage,
      diagnostics: sharedDiagnostics
    };
  }

  if (!parsed2 || !parsed2.ok) {
    const stats = summarizeDiagnostics(sharedDiagnostics);
    return {
      ok: true,
      formatted: parsed1.formatted,
      usedProviderId: run1.usedProviderId,
      usedProviderName: run1.usedProviderName,
      usedModel: run1.usedModel,
      usedFallback: run1.usedFallback,
      usedCrossProvider: run1.usedCrossProvider,
      totalRequests: stats.totalRequests,
      byModel: stats.byModel,
      usage: stats.usage,
      diagnostics: sharedDiagnostics
    };
  }

  const mergedQuestions = mergeMajorityQuestions([
    parsed1.questions,
    parsed2.questions
  ]);
  const stats = summarizeDiagnostics(sharedDiagnostics);

  return {
    ok: true,
    formatted: formatQuestions(mergedQuestions),
    usedProviderId: run2.usedProviderId || run1.usedProviderId,
    usedProviderName: run2.usedProviderName || run1.usedProviderName,
    usedModel: run2.usedModel || run1.usedModel,
    usedFallback: Boolean(run1.usedFallback || run2.usedFallback),
    usedCrossProvider: Boolean(run1.usedCrossProvider || run2.usedCrossProvider),
    totalRequests: stats.totalRequests,
    byModel: stats.byModel,
    usage: stats.usage,
    diagnostics: sharedDiagnostics
  };
}

/**
 * Xử lý lệnh Alt + Q (hoặc nút "Giải lại" khi bypassCache = true):
 * 1. Chống bấm dồn:
 *    - Nếu đang xử lý dở (inFlightContext != null): chụp và tính hash màn hình mới;
 *      nếu hash KHÔNG ĐỔI thì bỏ qua lần bấm mới (không hủy request đang chạy, không gọi lại).
 *      Chỉ khi màn hình đã thay đổi (hash khác) hoặc bấm "Giải lại" mới hủy request cũ và chạy mới.
 *    - Cooldown ngắn (~2 giây) giữa 2 lần gọi API hợp lệ liên tiếp trên cùng máy.
 * 2. Không trả tiền 2 lần cho cùng một màn hình:
 *    - Kiểm tra SHA-256 hash trong cache 10 phút; nếu trúng thì trả kết quả ngay kèm nhãn "(đã lưu)".
 */
export async function handleSolveCommand({ bypassCache = false } = {}) {
  const settings = await getSettings();
  if (!settings.enabled) {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") {
    return;
  }

  const tabId = tab.id;
  if (isRestrictedUrl(tab.url)) {
    await setErrorBadge(tabId);
    return;
  }

  const injected = await ensureContentScript(tabId);
  if (!injected) {
    await setErrorBadge(tabId);
    return;
  }

  await clearBadge(tabId);
  await loadScreenCacheFromSession();

  const previousInFlight = inFlightContext;

  try {
    // Bước 4: Ẩn bong bóng cũ và chờ 2 khung hình để bong bóng không lọt vào ảnh chụp
    await chrome.tabs.sendMessage(tabId, { type: "HIDE" });

    // Nếu bật "Ưu tiên đọc văn bản trang (DOM)", thử trích xuất các khối câu hỏi nằm trọn trong viewport
    let domText = "";
    if (settings.preferDomExtraction) {
      try {
        const domRes = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_DOM" });
        if (domRes && domRes.ok && domRes.count > 0 && typeof domRes.text === "string") {
          domText = domRes.text;
        }
      } catch (_) {}
    }

    // Bước 5: Chụp phần màn hình đang nhìn thấy
    let rawDataUrl = null;
    if (!domText) {
      rawDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png"
      });
    }

    const providerId = settings.provider;
    const providerCfg = settings.providers[providerId] || {};
    if (!providerCfg.apiKey || !providerCfg.apiKey.trim()) {
      await chrome.tabs.sendMessage(tabId, {
        type: "ERROR",
        text: "Chưa nhập API key, mở Options"
      });
      return;
    }

    // Bước 7: Resize / nén ảnh theo chế độ nếu dùng ảnh
    const processedDataUrl = rawDataUrl
      ? await processScreenshot(rawDataUrl, settings.mode)
      : null;

    const primaryModel =
      settings.mode === "accurate"
        ? providerCfg.accurateModel
        : providerCfg.fastModel;

    const { inputHash, cacheKey } = await buildScreenCacheKey({
      tabId,
      tabUrl: tab.url,
      mode: settings.mode,
      providerId,
      model: primaryModel,
      customPrompt: settings.customPrompt,
      contentPayload: domText || processedDataUrl || ""
    });

    // YÊU CẦU 2 (Chống bấm dồn khi đang xử lý):
    // Nếu đang có request chạy trên cùng tab và cùng cacheKey (cùng hash màn hình + chế độ + provider + model + prompt tùy chỉnh),
    // KHÔNG hủy request đang chạy và KHÔNG gửi request mới!
    if (
      !bypassCache &&
      previousInFlight &&
      previousInFlight.controller &&
      !previousInFlight.controller.signal.aborted &&
      previousInFlight.tabId === tabId &&
      previousInFlight.cacheKey === cacheKey
    ) {
      await chrome.tabs.sendMessage(tabId, { type: "LOADING" });
      return;
    }

    // Nếu màn hình hoặc cấu hình đã thay đổi (hoặc bấm "Giải lại"), hủy request cũ (nếu có)
    cancelActiveRequest();

    // YÊU CẦU 1 (Cache màn hình 10 phút):
    if (!bypassCache) {
      const cached = getCachedScreenResult(cacheKey);
      if (cached && cached.formatted) {
        await recordUsageStats({
          calls: 0,
          cacheHits: 1,
          pricing: settings.pricing
        });
        await chrome.tabs.sendMessage(tabId, {
          type: "RESULT",
          text: cached.formatted,
          providerName: cached.providerName || providerId,
          model: cached.model || primaryModel || "",
          usedFallback: Boolean(cached.usedFallback),
          usedCrossProvider: Boolean(cached.usedCrossProvider),
          fromCache: true,
          totalRequests: 0
        });
        return;
      }
    }

    // YÊU CẦU 2 (Cooldown ngắn ~2 giây giữa hai lần gọi API hợp lệ trên cùng máy):
    const now = Date.now();
    const elapsedSinceLastTrigger = now - lastTriggerTimestamp;
    if (!bypassCache && lastTriggerTimestamp > 0 && elapsedSinceLastTrigger < TRIGGER_COOLDOWN_MS) {
      const waitSec = Math.max(
        1,
        Math.ceil((TRIGGER_COOLDOWN_MS - elapsedSinceLastTrigger) / 1000)
      );
      await chrome.tabs.sendMessage(tabId, {
        type: "ERROR",
        text: `Thao tác quá nhanh, vui lòng chờ ${waitSec} giây`
      });
      return;
    }
    lastTriggerTimestamp = Date.now();

    const runId = ++activeRunId;
    const controller = new AbortController();
    activeController = controller;
    inFlightContext = {
      runId,
      tabId,
      inputHash,
      cacheKey,
      controller
    };

    // Bước 6: Hiện bong bóng đang xử lý "…"
    await chrome.tabs.sendMessage(tabId, { type: "LOADING" });
    if (runId !== activeRunId || controller.signal.aborted) return;

    // Bước 8 & 9: Gọi provider và lọc kết quả
    const outcome = await runSolver({
      providerId,
      imageDataUrl: processedDataUrl,
      mode: settings.mode,
      accurateMajorityVote: settings.accurateMajorityVote,
      config: {
        ...providerCfg,
        enableModelFallback: settings.enableModelFallback,
        enableCrossProviderFallback: settings.enableCrossProviderFallback,
        crossProviderOrder: settings.crossProviderOrder,
        allProvidersConfig: settings.providers,
        customPrompt: settings.customPrompt,
        domText
      },
      signal: controller.signal
    });
    if (runId !== activeRunId || controller.signal.aborted) return;

    // Ghi nhận thống kê token và chi tiêu cục bộ (Yêu cầu 8)
    if (outcome.totalRequests > 0 || outcome.usage) {
      await recordUsageStats({
        calls: outcome.totalRequests || 1,
        cacheHits: 0,
        inputTokens: outcome.usage?.inputTokens || 0,
        outputTokens: outcome.usage?.outputTokens || 0,
        reasoningTokens: outcome.usage?.reasoningTokens || 0,
        cachedTokens: outcome.usage?.cachedTokens || 0,
        pricing: settings.pricing
      });
    }

    if (outcome.usedModel) {
      saveSettings({
        lastSolveMeta: {
          providerId: outcome.usedProviderId || providerId,
          providerName: outcome.usedProviderName || providerId,
          model: outcome.usedModel,
          usedFallback: Boolean(outcome.usedFallback),
          usedCrossProvider: Boolean(outcome.usedCrossProvider),
          totalRequests: outcome.totalRequests || 1,
          byModel: outcome.byModel || {},
          usage: outcome.usage || null,
          timestamp: Date.now()
        }
      }).catch(() => {});
    }

    if (!outcome.ok) {
      await chrome.tabs.sendMessage(tabId, {
        type: "ERROR",
        text: outcome.error,
        canRetry: true
      });
      return;
    }

    // Chỉ lưu vào cache 10 phút khi có đáp án hợp lệ (không lưu khi rỗng "Không thấy câu hoàn chỉnh")
    if (outcome.formatted && outcome.formatted !== NO_COMPLETE_MESSAGE) {
      await setCachedScreenResult(cacheKey, {
        formatted: outcome.formatted,
        providerName: outcome.usedProviderName || providerId,
        model: outcome.usedModel || primaryModel || "",
        usedFallback: Boolean(outcome.usedFallback),
        usedCrossProvider: Boolean(outcome.usedCrossProvider)
      });
    }

    await chrome.tabs.sendMessage(tabId, {
      type: "RESULT",
      text: outcome.formatted,
      providerName: outcome.usedProviderName || providerId,
      model: outcome.usedModel || "",
      usedFallback: Boolean(outcome.usedFallback),
      usedCrossProvider: Boolean(outcome.usedCrossProvider),
      fromCache: false,
      totalRequests: outcome.totalRequests || 1
    });
  } catch (err) {
    if (
      inFlightContext?.controller?.signal?.aborted ||
      err?.aborted
    ) {
      return;
    }
    const errText = err?.message || "Đã xảy ra lỗi khi giải câu hỏi";
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "ERROR",
        text: errText,
        canRetry: err?.code === "TRUNCATED_OUTPUT" || err?.code === "OVERLOADED"
      });
    } catch (_) {
      await setErrorBadge(tabId);
    }
  } finally {
    if (inFlightContext && inFlightContext.controller === activeController) {
      inFlightContext = null;
      activeController = null;
    }
  }
}

async function handleToggleModeCommand() {
  const settings = await getSettings();
  const nextMode = settings.mode === "fast" ? "accurate" : "fast";
  await saveSettings({ mode: nextMode });
}

if (typeof chrome !== "undefined" && chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "solve") {
      handleSolveCommand({ bypassCache: false });
    } else if (command === "toggle-mode") {
      handleToggleModeCommand();
    }
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "CANCEL") {
      cancelActiveRequest();
      sendResponse({ cancelled: true });
      return false;
    }
    if (message && message.type === "FORCE_RESOLVE") {
      handleSolveCommand({ bypassCache: true });
      sendResponse({ started: true });
      return false;
    }
    return false;
  });
}
