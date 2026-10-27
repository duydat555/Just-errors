export const STORAGE_KEY = "just_errors_settings";
export const USAGE_STORAGE_KEY = "just_errors_usage_stats";
export const SCREEN_CACHE_STORAGE_KEY = "just_errors_screen_cache";

/**
 * Tên model mặc định đã đối chiếu tài liệu chính thức hiện hành của từng hãng:
 * - Anthropic: claude-haiku-5-5 (Nhanh) / claude-opus-5-5 (Chính xác) / dự phòng: claude-haiku-5-5
 * - OpenAI: gpt-6-luna (Nhanh) / gpt-6.1-sol hoặc gpt-6-astra (Chính xác) / dự phòng: gpt-6-luna
 * - Google Gemini: gemini-3.8-flash (Nhanh) / gemini-4-argon (Chính xác) / dự phòng: gemini-3.6-flash
 * - DeepSeek: deepseek-flash (hỗ trợ Vision + bật/tắt Thinking; deepseek-v4-pro chỉ nhận văn bản)
 */
export const PROVIDER_META = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    shortName: "Anthropic",
    supportsVision: true,
    defaultFastModel: "claude-haiku-5-5",
    defaultAccurateModel: "claude-opus-5-5",
    defaultFallbackModel: "claude-haiku-5-5"
  },
  openai: {
    id: "openai",
    name: "OpenAI (ChatGPT)",
    shortName: "OpenAI",
    supportsVision: true,
    defaultFastModel: "gpt-6-luna",
    defaultAccurateModel: "gpt-6-astra",
    defaultFallbackModel: "gpt-6-luna"
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    shortName: "Gemini",
    supportsVision: true,
    defaultFastModel: "gemini-3.8-flash",
    defaultAccurateModel: "gemini-4-argon",
    defaultFallbackModel: "gemini-3.6-flash"
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    shortName: "DeepSeek",
    supportsVision: true,
    defaultFastModel: "deepseek-flash",
    defaultAccurateModel: "deepseek-flash",
    defaultFallbackModel: "deepseek-flash"
  }
};

export const DEFAULT_CROSS_PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "deepseek",
  "gemini"
];

export const DEFAULT_PRICING = {
  inputPricePerMillion: 2.0,  // Mặc định 2$/1M token vào (ví dụ gpt-6.1-sol)
  outputPricePerMillion: 10.0, // Mặc định 10$/1M token ra (ví dụ gpt-6.1-sol)
  budgetAlertUsd: 3.0          // Cảnh báo khi chi phí ước tính vượt 3$
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "fast", // "fast" | "accurate"
  provider: "anthropic", // "anthropic" | "openai" | "gemini" | "deepseek"
  accurateMajorityVote: false, // Mặc định TẮT để tránh nhân đôi chi phí
  preferDomExtraction: false,
  enableModelFallback: true,
  enableCrossProviderFallback: false,
  crossProviderOrder: DEFAULT_CROSS_PROVIDER_ORDER,
  pricing: DEFAULT_PRICING,
  customPrompt: "",
  lastSolveMeta: null,
  providers: {
    anthropic: {
      apiKey: "",
      fastModel: PROVIDER_META.anthropic.defaultFastModel,
      accurateModel: PROVIDER_META.anthropic.defaultAccurateModel,
      fallbackModel: PROVIDER_META.anthropic.defaultFallbackModel
    },
    openai: {
      apiKey: "",
      fastModel: PROVIDER_META.openai.defaultFastModel,
      accurateModel: PROVIDER_META.openai.defaultAccurateModel,
      fallbackModel: PROVIDER_META.openai.defaultFallbackModel
    },
    gemini: {
      apiKey: "",
      fastModel: PROVIDER_META.gemini.defaultFastModel,
      accurateModel: PROVIDER_META.gemini.defaultAccurateModel,
      fallbackModel: PROVIDER_META.gemini.defaultFallbackModel
    },
    deepseek: {
      apiKey: "",
      fastModel: PROVIDER_META.deepseek.defaultFastModel,
      accurateModel: PROVIDER_META.deepseek.defaultAccurateModel,
      fallbackModel: PROVIDER_META.deepseek.defaultFallbackModel
    }
  }
};

export function normalizeProviderOrder(rawOrder) {
  let list = [];
  if (Array.isArray(rawOrder)) {
    list = rawOrder;
  } else if (typeof rawOrder === "string") {
    list = rawOrder.split(/[,;\s]+/);
  }
  const cleaned = [];
  for (const item of list) {
    const id = String(item || "").trim().toLowerCase();
    if (PROVIDER_META[id] && !cleaned.includes(id)) {
      cleaned.push(id);
    }
  }
  for (const id of DEFAULT_CROSS_PROVIDER_ORDER) {
    if (!cleaned.includes(id)) {
      cleaned.push(id);
    }
  }
  return cleaned;
}

function normalizePositiveNumber(val, fallback) {
  const num = typeof val === "number" ? val : Number.parseFloat(String(val ?? ""));
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

export function mergeWithDefaults(raw = {}) {
  const rawPricing = raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {};
  const merged = {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    mode: raw.mode === "accurate" ? "accurate" : "fast",
    provider: PROVIDER_META[raw.provider] ? raw.provider : DEFAULT_SETTINGS.provider,
    accurateMajorityVote: Boolean(raw.accurateMajorityVote),
    preferDomExtraction: Boolean(raw.preferDomExtraction),
    enableModelFallback:
      typeof raw.enableModelFallback === "boolean"
        ? raw.enableModelFallback
        : DEFAULT_SETTINGS.enableModelFallback,
    enableCrossProviderFallback: Boolean(raw.enableCrossProviderFallback),
    crossProviderOrder: normalizeProviderOrder(raw.crossProviderOrder),
    pricing: {
      inputPricePerMillion: normalizePositiveNumber(
        rawPricing.inputPricePerMillion,
        DEFAULT_PRICING.inputPricePerMillion
      ),
      outputPricePerMillion: normalizePositiveNumber(
        rawPricing.outputPricePerMillion,
        DEFAULT_PRICING.outputPricePerMillion
      ),
      budgetAlertUsd: normalizePositiveNumber(
        rawPricing.budgetAlertUsd,
        DEFAULT_PRICING.budgetAlertUsd
      )
    },
    customPrompt: typeof raw.customPrompt === "string" ? raw.customPrompt : "",
    lastSolveMeta: raw.lastSolveMeta || null,
    providers: {}
  };

  for (const [id, meta] of Object.entries(PROVIDER_META)) {
    const src = (raw.providers && raw.providers[id]) || {};
    merged.providers[id] = {
      apiKey: typeof src.apiKey === "string" ? src.apiKey.trim() : "",
      fastModel:
        typeof src.fastModel === "string" && src.fastModel.trim()
          ? src.fastModel.trim()
          : meta.defaultFastModel,
      accurateModel:
        typeof src.accurateModel === "string" && src.accurateModel.trim()
          ? src.accurateModel.trim()
          : meta.defaultAccurateModel,
      fallbackModel:
        typeof src.fallbackModel === "string"
          ? src.fallbackModel.trim()
          : meta.defaultFallbackModel
    };
  }

  return merged;
}

export async function getSettings() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return mergeWithDefaults(data ? data[STORAGE_KEY] : {});
  } catch (_) {
    return mergeWithDefaults({});
  }
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const nextProviders = { ...current.providers };
  if (partial && partial.providers) {
    for (const [id, cfg] of Object.entries(partial.providers)) {
      if (nextProviders[id] && cfg) {
        nextProviders[id] = { ...nextProviders[id], ...cfg };
      }
    }
  }
  const nextPricing = {
    ...current.pricing,
    ...(partial && partial.pricing ? partial.pricing : {})
  };
  const next = mergeWithDefaults({
    ...current,
    ...partial,
    pricing: nextPricing,
    providers: nextProviders
  });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/**
 * Lấy chuỗi ngày cục bộ YYYY-MM-DD để thống kê chi tiêu theo ngày.
 */
export function getLocalDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Ước tính chi phí USD từ số lượng token và bảng giá cấu hình.
 */
export function estimateCostUsd(
  { inputTokens = 0, outputTokens = 0 } = {},
  pricing = DEFAULT_PRICING
) {
  const inRate = normalizePositiveNumber(
    pricing?.inputPricePerMillion,
    DEFAULT_PRICING.inputPricePerMillion
  );
  const outRate = normalizePositiveNumber(
    pricing?.outputPricePerMillion,
    DEFAULT_PRICING.outputPricePerMillion
  );
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
}

function makeEmptyDayBucket() {
  return {
    calls: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    estimatedCostUsd: 0
  };
}

/**
 * Đọc thống kê sử dụng và chi tiêu cục bộ từ chrome.storage.local.
 * Tuyệt đối chỉ chứa số liệu đếm, không lưu ảnh hay nội dung câu hỏi.
 */
export async function getUsageStats() {
  const todayKey = getLocalDateKey();
  try {
    const raw = await chrome.storage.local.get(USAGE_STORAGE_KEY);
    const stored = (raw && raw[USAGE_STORAGE_KEY]) || {};
    const days = stored.days && typeof stored.days === "object" ? stored.days : {};
    const today = { ...makeEmptyDayBucket(), ...(days[todayKey] || {}) };
    const total = { ...makeEmptyDayBucket(), ...(stored.total || {}) };
    return {
      todayKey,
      today,
      total,
      days
    };
  } catch (_) {
    return {
      todayKey,
      today: makeEmptyDayBucket(),
      total: makeEmptyDayBucket(),
      days: {}
    };
  }
}

/**
 * Cộng dồn số liệu token / chi phí hoặc lượt dùng lại cache vào chrome.storage.local.
 */
export async function recordUsageStats({
  calls = 0,
  cacheHits = 0,
  inputTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
  cachedTokens = 0,
  pricing = DEFAULT_PRICING
} = {}) {
  const stats = await getUsageStats();
  const todayKey = stats.todayKey;
  const addedCost = estimateCostUsd({ inputTokens, outputTokens }, pricing);

  const updatedToday = {
    calls: stats.today.calls + calls,
    cacheHits: stats.today.cacheHits + cacheHits,
    inputTokens: stats.today.inputTokens + inputTokens,
    outputTokens: stats.today.outputTokens + outputTokens,
    reasoningTokens: stats.today.reasoningTokens + reasoningTokens,
    cachedTokens: stats.today.cachedTokens + cachedTokens,
    estimatedCostUsd: Number((stats.today.estimatedCostUsd + addedCost).toFixed(6))
  };

  const updatedTotal = {
    calls: stats.total.calls + calls,
    cacheHits: stats.total.cacheHits + cacheHits,
    inputTokens: stats.total.inputTokens + inputTokens,
    outputTokens: stats.total.outputTokens + outputTokens,
    reasoningTokens: stats.total.reasoningTokens + reasoningTokens,
    cachedTokens: stats.total.cachedTokens + cachedTokens,
    estimatedCostUsd: Number((stats.total.estimatedCostUsd + addedCost).toFixed(6))
  };

  const nextDays = { ...stats.days, [todayKey]: updatedToday };
  // Chỉ giữ tối đa 30 ngày gần nhất để bộ nhớ gọn nhẹ
  const sortedKeys = Object.keys(nextDays).sort();
  while (sortedKeys.length > 30) {
    const oldest = sortedKeys.shift();
    delete nextDays[oldest];
  }

  const nextData = {
    total: updatedTotal,
    days: nextDays
  };

  try {
    await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: nextData });
  } catch (_) {}

  return {
    todayKey,
    today: updatedToday,
    total: updatedTotal,
    days: nextDays
  };
}

export async function resetUsageStats() {
  const empty = {
    total: makeEmptyDayBucket(),
    days: {}
  };
  try {
    await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: empty });
  } catch (_) {}
  return getUsageStats();
}
