import { PROVIDER_META } from "../lib/settings.js";
import * as anthropicProvider from "./anthropic.js";
import * as openaiProvider from "./openai.js";
import * as geminiProvider from "./gemini.js";
import * as deepseekProvider from "./deepseek.js";

export class ProviderError extends Error {
  constructor(
    message,
    {
      code = "UNKNOWN",
      status = null,
      apiMessage = "",
      retryable = false,
      aborted = false,
      retryAfterMs = 0,
      isFreeTier = false,
      diagnostics = []
    } = {}
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.apiMessage = apiMessage;
    this.retryable = retryable;
    this.aborted = aborted;
    this.retryAfterMs = retryAfterMs;
    this.isFreeTier = isFreeTier;
    this.diagnostics = diagnostics;
  }
}

const COOLDOWN_STORAGE_KEY = "just_errors_cooldowns";
const DEFAULT_429_COOLDOWN_MS = 20000;
const MAX_INLINE_429_WAIT_MS = 5000;

const memoryCooldowns = new Map();

function makeCooldownKey(providerId, model) {
  const p = String(providerId || "unknown").trim().toLowerCase();
  const m = String(model || "default").trim().replace(/^models\//, "").toLowerCase();
  return `${p}:${m}`;
}

async function syncCooldownToSessionStorage() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const obj = {};
      const now = Date.now();
      for (const [k, v] of memoryCooldowns.entries()) {
        if (v && v.until > now) {
          obj[k] = v;
        }
      }
      await chrome.storage.session.set({ [COOLDOWN_STORAGE_KEY]: obj });
    }
  } catch (_) {}
}

export async function loadCooldownsFromSessionStorage() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const data = await chrome.storage.session.get(COOLDOWN_STORAGE_KEY);
      const mapObj = data ? data[COOLDOWN_STORAGE_KEY] : null;
      if (mapObj && typeof mapObj === "object") {
        const now = Date.now();
        for (const [k, v] of Object.entries(mapObj)) {
          if (v && typeof v.until === "number" && v.until > now) {
            memoryCooldowns.set(k, v);
          }
        }
      }
    }
  } catch (_) {}
}

export function setModelCooldown(providerId, model, durationMs, { isFreeTier = false } = {}) {
  const effectiveMs = Math.max(1000, Math.round(durationMs || DEFAULT_429_COOLDOWN_MS));
  const key = makeCooldownKey(providerId, model);
  memoryCooldowns.set(key, {
    until: Date.now() + effectiveMs,
    durationMs: effectiveMs,
    isFreeTier: Boolean(isFreeTier)
  });
  syncCooldownToSessionStorage();
}

export function getModelCooldownRemainingMs(providerId, model) {
  if (!model) return 0;
  const key = makeCooldownKey(providerId, model);
  const entry = memoryCooldowns.get(key);
  if (!entry) return 0;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    memoryCooldowns.delete(key);
    return 0;
  }
  return remaining;
}

export function getModelCooldownEntry(providerId, model) {
  const remainingMs = getModelCooldownRemainingMs(providerId, model);
  if (remainingMs <= 0) return null;
  const entry = memoryCooldowns.get(makeCooldownKey(providerId, model));
  return {
    remainingMs,
    remainingSec: Math.max(1, Math.ceil(remainingMs / 1000)),
    isFreeTier: Boolean(entry?.isFreeTier)
  };
}

export function clearAllCooldowns() {
  memoryCooldowns.clear();
  syncCooldownToSessionStorage();
}

/**
 * Làm sạch thông điệp lỗi từ server (tuyệt đối không để lộ API key).
 */
export function sanitizeErrorMessage(rawMessage, apiKey = "") {
  if (typeof rawMessage !== "string") return "";
  let msg = rawMessage.trim();
  if (!msg) return "";

  if (apiKey && typeof apiKey === "string" && apiKey.trim().length >= 4) {
    const trimmedKey = apiKey.trim();
    msg = msg.split(trimmedKey).join("[REDACTED]");
  }

  msg = msg
    .replace(/\bsk-[A-Za-z0-9_*-]{4,}\b/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_*-]{6,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();

  if (msg.length > 140) {
    msg = `${msg.slice(0, 137)}...`;
  }
  return msg;
}

export function extractApiErrorMessage(rawText, apiKey = "") {
  if (typeof rawText !== "string" || !rawText.trim()) return "";
  const trimmed = rawText.trim();

  try {
    const parsed = JSON.parse(trimmed);
    const candidate =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.error_description ||
      (typeof parsed?.error === "string" ? parsed.error : "");
    if (typeof candidate === "string" && candidate.trim()) {
      return sanitizeErrorMessage(candidate, apiKey);
    }
  } catch (_) {}

  const plain = trimmed.replace(/<[^>]+>/g, " ");
  return sanitizeErrorMessage(plain, apiKey);
}

export function parseDurationToMs(val) {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) {
    return Math.round(val * 1000);
  }
  if (typeof val !== "string") return 0;
  const s = val.trim();
  if (!s) return 0;

  if (/^\d+(?:\.\d+)?$/.test(s)) {
    return Math.round(Number.parseFloat(s) * 1000);
  }

  let totalMs = 0;
  const minMatch = s.match(/(\d+(?:\.\d+)?)\s*m(?!s)/i);
  const secMatch = s.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/i);
  const msMatch = s.match(/(\d+(?:\.\d+)?)\s*ms\b/i);

  if (minMatch) totalMs += Number.parseFloat(minMatch[1]) * 60000;
  if (secMatch) totalMs += Number.parseFloat(secMatch[1]) * 1000;
  if (msMatch) totalMs += Number.parseFloat(msMatch[1]);

  if (totalMs > 0) return Math.round(totalMs);

  const parsedDate = Date.parse(s);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    if (diff > 0) return diff;
  }
  return 0;
}

/**
 * Trích xuất:
 * - retryAfterMs (từ Retry-After header hoặc retryDelay trong body)
 * - isFreeTier (dấu hiệu FreeTier trong QuotaFailure của Gemini)
 * - isInsufficientQuota (hết tiền / hết credit: insufficient_quota, HTTP 402, credit balance is too low...)
 */
export function extractRetryAndQuotaInfo(
  headers,
  rawBodyText = "",
  status = 429,
  providerId = ""
) {
  let retryAfterMs = 0;
  let isFreeTier = false;
  let isInsufficientQuota = status === 402;
  let hasRateLimitResetDetails = false;

  if (headers && typeof headers.get === "function") {
    const retryAfterHeader =
      headers.get("retry-after") ||
      headers.get("Retry-After") ||
      headers.get("x-ratelimit-reset-requests");
    const retryAfterMsHeader = headers.get("retry-after-ms");

    if (retryAfterMsHeader && /^\d+/.test(retryAfterMsHeader.trim())) {
      retryAfterMs = Number.parseInt(retryAfterMsHeader.trim(), 10);
      hasRateLimitResetDetails = true;
    } else if (retryAfterHeader) {
      retryAfterMs = parseDurationToMs(retryAfterHeader);
      hasRateLimitResetDetails = retryAfterMs > 0;
    }
  }

  if (typeof rawBodyText === "string" && rawBodyText.trim()) {
    if (/freetier|free_tier|free\s+tier/i.test(rawBodyText)) {
      isFreeTier = true;
    }

    if (
      /insufficient_quota|billing_hard_limit_reached|credit\s+balance\s+is\s+too\s+low|insufficient\s+balance|out\s+of\s+credits/i.test(
        rawBodyText
      )
    ) {
      isInsufficientQuota = true;
    }

    try {
      const parsed = JSON.parse(rawBodyText);
      const errCode = String(parsed?.error?.code || "").toLowerCase();
      const errType = String(parsed?.error?.type || "").toLowerCase();

      if (
        errCode === "insufficient_quota" ||
        errType === "insufficient_quota" ||
        errCode === "billing_hard_limit_reached"
      ) {
        isInsufficientQuota = true;
      }

      const details = parsed?.error?.details;
      if (Array.isArray(details)) {
        for (const d of details) {
          if (!d || typeof d !== "object") continue;
          if (typeof d.retryDelay === "string") {
            hasRateLimitResetDetails = true;
            if (!retryAfterMs) {
              retryAfterMs = parseDurationToMs(d.retryDelay);
            }
          }
          if (Array.isArray(d.violations)) {
            for (const v of d.violations) {
              const qId = `${v?.quotaId || ""} ${v?.quotaMetric || ""}`;
              if (/freetier|free/i.test(qId)) {
                isFreeTier = true;
              }
              if (/perminute|perday|rate/i.test(qId)) {
                hasRateLimitResetDetails = true;
              }
            }
          }
        }
      }

      if (!retryAfterMs && typeof parsed?.error?.retryDelay === "string") {
        retryAfterMs = parseDurationToMs(parsed.error.retryDelay);
        hasRateLimitResetDetails = true;
      }

      const msg = String(parsed?.error?.message || parsed?.message || "");
      if (!retryAfterMs && msg) {
        const m = msg.match(
          /(?:retry\s+in|try\s+again\s+in|retry\s+after)\s+(\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)?)/i
        );
        if (m) {
          retryAfterMs = parseDurationToMs(m[1]);
          hasRateLimitResetDetails = true;
        }
      }

      // Trên OpenAI / Anthropic / DeepSeek: thông báo "exceeded your current quota, please check your plan and billing details"
      // mà không có RetryInfo / FreeTier là lỗi hết tiền (insufficient_quota)
      if (
        providerId !== "gemini" &&
        !hasRateLimitResetDetails &&
        /exceeded your current quota.*billing/i.test(msg)
      ) {
        isInsufficientQuota = true;
      }
    } catch (_) {
      const m = rawBodyText.match(
        /(?:retry\s+in|try\s+again\s+in|retry\s+after)\s+(\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)?)/i
      );
      if (m && !retryAfterMs) {
        retryAfterMs = parseDurationToMs(m[1]);
      }
    }
  }

  return {
    retryAfterMs: Math.max(0, retryAfterMs),
    isFreeTier,
    isInsufficientQuota
  };
}

/**
 * Đọc trường usage (token vào, token ra, token suy luận, token cache) từ phản hồi JSON của từng provider.
 */
export function extractUsageFromResponse(json, providerId = "") {
  if (!json || typeof json !== "object") {
    return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  }

  if (providerId === "gemini" || json.usageMetadata) {
    const meta = json.usageMetadata || {};
    const inputTokens = Number(meta.promptTokenCount || 0);
    const candidatesTokens = Number(meta.candidatesTokenCount || 0);
    const thoughtsTokens = Number(meta.thoughtsTokenCount || 0);
    const cachedTokens = Number(meta.cachedContentTokenCount || 0);
    return {
      inputTokens,
      outputTokens: candidatesTokens + thoughtsTokens,
      reasoningTokens: thoughtsTokens,
      cachedTokens
    };
  }

  const u = json.usage || {};
  if (providerId === "anthropic" || ("input_tokens" in u && !("prompt_tokens" in u))) {
    const cacheRead = Number(u.cache_read_input_tokens || 0);
    const cacheCreate = Number(u.cache_creation_input_tokens || 0);
    const baseInput = Number(u.input_tokens || 0);
    const outputTokens = Number(u.output_tokens || 0);
    return {
      inputTokens: baseInput + cacheRead + cacheCreate,
      outputTokens,
      reasoningTokens: 0,
      cachedTokens: cacheRead
    };
  }

  // OpenAI & DeepSeek
  const inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  const reasoningTokens = Number(
    u.completion_tokens_details?.reasoning_tokens ??
      u.output_tokens_details?.reasoning_tokens ??
      0
  );
  const cachedTokens = Number(
    u.prompt_tokens_details?.cached_tokens ??
      u.input_tokens_details?.cached_tokens ??
      u.prompt_cache_hit_tokens ??
      0
  );

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens
  };
}

export function extractBase64Image(imageDataUrl) {
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:")) {
    throw new ProviderError("Ảnh chụp màn hình không hợp lệ", { code: "INVALID_IMAGE" });
  }
  const commaIdx = imageDataUrl.indexOf(",");
  if (commaIdx === -1) {
    throw new ProviderError("Ảnh chụp màn hình không hợp lệ", { code: "INVALID_IMAGE" });
  }
  const header = imageDataUrl.slice(5, commaIdx);
  const data = imageDataUrl.slice(commaIdx + 1).replace(/\s+/g, "");
  const mimeMatch = header.match(/^([^;]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
  return { mimeType, data };
}

/**
 * Ánh xạ mã lỗi HTTP + thông điệp thực tế từ API sang ProviderError.
 * - Hết credit (insufficient_quota / 402): báo "Hết credit <Provider>, nạp thêm hoặc đổi provider", KHÔNG retry.
 * - 429 (rate_limit_exceeded): báo hạn mức tốc độ kèm thời gian chờ.
 * - 503: báo máy chủ AI quá tải.
 */
export function mapStatusToError(
  status,
  apiMessage = "",
  durationMs = 0,
  {
    providerId = "gemini",
    retryAfterMs = 0,
    isFreeTier = false,
    isInsufficientQuota = false
  } = {}
) {
  const cleanMsg = typeof apiMessage === "string" ? apiMessage.trim() : "";
  const prefix = cleanMsg ? `${status}: ${cleanMsg} — ` : `${status}: `;
  const pName = PROVIDER_META[providerId]?.shortName || "AI";

  if (isInsufficientQuota) {
    return new ProviderError(`Hết credit ${pName}, nạp thêm hoặc đổi provider`, {
      code: "INSUFFICIENT_QUOTA",
      status,
      apiMessage: cleanMsg,
      retryable: false
    });
  }

  const isInvalidKeyOn400 =
    status === 400 &&
    /api[_\s-]?key\s+not\s+valid|api_key_invalid|invalid\s+api[_\s-]?key|invalid\s+x-api-key|incorrect\s+api\s+key|authentication\s+fails/i.test(
      cleanMsg
    );

  if (status === 401 || status === 403 || isInvalidKeyOn400) {
    return new ProviderError(`${prefix}Sai API key`, {
      code: "AUTH_ERROR",
      status,
      apiMessage: cleanMsg,
      retryable: false
    });
  }

  const isModelNotFoundOn400 =
    status === 400 &&
    /model\s+not\s+found|models\/[^\s]+ is not found|does not exist|not supported for generatecontent|unknown model/i.test(
      cleanMsg
    );

  if (status === 404 || isModelNotFoundOn400) {
    return new ProviderError(
      `${prefix}Không tìm thấy model (kiểm tra tên model trong Options)`,
      {
        code: "MODEL_NOT_FOUND",
        status,
        apiMessage: cleanMsg,
        retryable: false
      }
    );
  }

  if (status === 429) {
    const waitSec = Math.max(
      1,
      Math.ceil((retryAfterMs > 0 ? retryAfterMs : DEFAULT_429_COOLDOWN_MS) / 1000)
    );
    const tierNote = isFreeTier ? " - gói Free tier của bạn" : " - hạn mức của bạn";
    const billingHint = providerId === "gemini" ? " hoặc bật billing" : "";
    return new ProviderError(
      `${prefix}Hết hạn mức ${pName} (429${tierNote}), thử lại sau ${waitSec} giây${billingHint}`,
      {
        code: "RATE_LIMIT",
        status: 429,
        apiMessage: cleanMsg,
        retryable: true,
        retryAfterMs,
        isFreeTier
      }
    );
  }

  if (status === 503) {
    const serverLabel = providerId === "gemini" ? "máy chủ Google" : `máy chủ ${pName}`;
    const suffix =
      durationMs >= 4000
        ? `Máy chủ ${pName} phản hồi chậm hoặc đang quá tải (503 - lỗi phía ${serverLabel}), vui lòng thử lại hoặc đổi model`
        : `Model đang quá tải tạm thời (503 - ${serverLabel} quá tải), vui lòng thử lại hoặc đổi model`;
    return new ProviderError(`${prefix}${suffix}`, {
      code: "OVERLOADED",
      status: 503,
      apiMessage: cleanMsg,
      retryable: true
    });
  }

  if (status >= 500 && status <= 599) {
    return new ProviderError(`${prefix}Lỗi máy chủ ${pName} (${status}), vui lòng thử lại`, {
      code: "SERVER_ERROR",
      status,
      apiMessage: cleanMsg,
      retryable: true
    });
  }

  return new ProviderError(
    cleanMsg
      ? `${status}: ${cleanMsg} — Yêu cầu không hợp lệ`
      : `${status}: Yêu cầu không hợp lệ (kiểm tra cấu hình model)`,
    {
      code: "HTTP_ERROR",
      status,
      apiMessage: cleanMsg,
      retryable: false
    }
  );
}

export function isParameterCompatibilityError(err) {
  if (!(err instanceof ProviderError)) return false;
  if (err.status !== 400 || err.code !== "HTTP_ERROR") return false;
  const msg = (err.apiMessage || "").toLowerCase();
  if (
    msg.includes("credit") ||
    msg.includes("balance") ||
    msg.includes("billing") ||
    msg.includes("quota") ||
    msg.includes("api key") ||
    msg.includes("not found")
  ) {
    return false;
  }
  return true;
}

export function isOverloadOrServerError(err) {
  if (!(err instanceof ProviderError)) return false;
  if (err.code === "INSUFFICIENT_QUOTA") return false;
  return (
    err.code === "OVERLOADED" ||
    err.code === "SERVER_ERROR" ||
    err.code === "RATE_LIMIT" ||
    err.code === "COOLDOWN" ||
    err.code === "TIMEOUT" ||
    err.status === 503 ||
    err.status === 529 ||
    err.status === 429 ||
    (typeof err.status === "number" && err.status >= 500)
  );
}

function sleepWithSignal(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("Đã hủy yêu cầu", { code: "ABORTED", aborted: true }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("Đã hủy yêu cầu", { code: "ABORTED", aborted: true }));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function computeRetryBackoffMs(attempt, baseDelayMs = 1000) {
  const exp = Math.pow(2, Math.max(0, attempt - 1)) * baseDelayMs;
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.round(exp * jitter);
}

/**
 * Tổng hợp thống kê số lượng request và tổng số token (usage) từ mảng diagnostics.
 */
export function summarizeDiagnostics(diagnostics = []) {
  const byModel = {};
  let totalRequests = 0;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0
  };

  if (Array.isArray(diagnostics)) {
    for (const d of diagnostics) {
      if (!d || d.skipped) continue;
      totalRequests += 1;
      const key = d.model || "unknown";
      byModel[key] = (byModel[key] || 0) + 1;
      if (d.usage && typeof d.usage === "object") {
        usage.inputTokens += Number(d.usage.inputTokens || 0);
        usage.outputTokens += Number(d.usage.outputTokens || 0);
        usage.reasoningTokens += Number(d.usage.reasoningTokens || 0);
        usage.cachedTokens += Number(d.usage.cachedTokens || 0);
      }
    }
  }

  return { totalRequests, byModel, usage };
}

/**
 * Định dạng chuỗi chẩn đoán kèm bộ đếm số request theo từng model và tổng cộng
 * (KHÔNG bao giờ chứa API key, ảnh hay nội dung đề).
 */
export function formatDiagnosticsSummary(diagnostics = []) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return "";
  const { totalRequests, byModel, usage } = summarizeDiagnostics(diagnostics);
  const modelCountsStr = Object.entries(byModel)
    .map(([m, c]) => `${m}: ${c}`)
    .join(", ");

  const stepsStr = diagnostics
    .map((d) => {
      const target = d.model || d.step || "request";
      if (d.skipped) {
        return `[${target}: bỏ qua do cooldown (${d.cooldownSec || 0}s)]`;
      }
      const st = d.status ? `HTTP ${d.status}` : d.errorType || "ERR";
      const waitTag = d.waitedMs ? `, chờ ${d.waitedMs}ms` : "";
      return `[${target} #${d.attempt}: ${st} (${d.durationMs}ms${waitTag})]`;
    })
    .join(" → ");

  const tokenTag =
    usage.inputTokens > 0 || usage.outputTokens > 0
      ? ` · Token vào/ra: ${usage.inputTokens}/${usage.outputTokens} (cache: ${usage.cachedTokens})`
      : "";

  const countHeader =
    totalRequests > 0
      ? `Tổng: ${totalRequests} req (${modelCountsStr})${tokenTag} | `
      : `Tổng: 0 req | `;
  return `${countHeader}${stepsStr}`;
}

function inferProviderIdFromUrl(url = "") {
  const u = String(url).toLowerCase();
  if (u.includes("generativelanguage.googleapis.com")) return "gemini";
  if (u.includes("api.anthropic.com")) return "anthropic";
  if (u.includes("api.openai.com")) return "openai";
  if (u.includes("api.deepseek.com")) return "deepseek";
  return "gemini";
}

export async function fetchProviderJson({
  url,
  method = "POST",
  headers,
  body,
  mode = "fast",
  signal,
  timeoutMs,
  maxAttempts = 2,
  retryBaseDelayMs = 1000,
  apiKey = "",
  providerId = "",
  diagnostics = null,
  diagnosticLabel = ""
}) {
  const effectiveProviderId = providerId || inferProviderIdFromUrl(url);
  const totalBudgetMs =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : mode === "accurate"
        ? 60000
        : 30000;

  const startOverall = Date.now();
  const deadline = startOverall + totalBudgetMs;
  const attemptsLimit = Math.max(1, maxAttempts);
  let lastError = null;
  let retried429 = false;
  let pendingWaitMs = 0;

  const modelName =
    diagnosticLabel ||
    (body && typeof body === "object" && body.model ? String(body.model) : "");

  for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
    if (signal?.aborted) {
      throw new ProviderError("Đã hủy yêu cầu", { code: "ABORTED", aborted: true });
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      if (lastError && (lastError.status === 503 || lastError.code === "OVERLOADED")) {
        throw new ProviderError(
          "Máy chủ AI phản hồi chậm hoặc đang quá tải (503), vui lòng thử lại hoặc đổi model",
          {
            code: "OVERLOADED",
            status: 503,
            apiMessage: lastError.apiMessage,
            diagnostics: Array.isArray(diagnostics) ? diagnostics : []
          }
        );
      }
      throw new ProviderError("Hết thời gian chờ", {
        code: "TIMEOUT",
        retryable: false,
        diagnostics: Array.isArray(diagnostics) ? diagnostics : []
      });
    }

    const attemptController = new AbortController();
    let timedOut = false;

    const onExternalAbort = () => {
      attemptController.abort();
    };

    if (signal) {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, remainingMs);

    const attemptStart = Date.now();
    const waitedBeforeThisAttempt = pendingWaitMs;
    pendingWaitMs = 0;

    try {
      const fetchInit = {
        method,
        headers,
        signal: attemptController.signal
      };
      if (body !== undefined && method !== "GET") {
        fetchInit.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchInit);
      const durationMs = Date.now() - attemptStart;

      if (!response.ok) {
        let rawErrText = "";
        try {
          rawErrText = await response.text();
        } catch (_) {}

        const apiMessage = extractApiErrorMessage(rawErrText, apiKey);
        const { retryAfterMs, isFreeTier, isInsufficientQuota } =
          response.status === 429 || response.status === 402 || response.status === 400
            ? extractRetryAndQuotaInfo(
                response.headers,
                rawErrText,
                response.status,
                effectiveProviderId
              )
            : { retryAfterMs: 0, isFreeTier: false, isInsufficientQuota: false };

        const httpErr = mapStatusToError(response.status, apiMessage, durationMs, {
          providerId: effectiveProviderId,
          retryAfterMs,
          isFreeTier,
          isInsufficientQuota
        });

        if (Array.isArray(diagnostics)) {
          diagnostics.push({
            providerId: effectiveProviderId,
            model: modelName,
            attempt,
            status: response.status,
            durationMs,
            waitedMs: waitedBeforeThisAttempt,
            totalElapsedMs: Date.now() - startOverall,
            errorType: "HTTP",
            retryAfterMs: retryAfterMs || 0
          });
        }
        httpErr.diagnostics = Array.isArray(diagnostics) ? diagnostics : [];

        // Nếu hết credit (insufficient_quota): KHÔNG retry, dừng ngay lập tức
        if (httpErr.code === "INSUFFICIENT_QUOTA") {
          throw httpErr;
        }

        // Xử lý 429 vượt tốc độ (rate_limit_exceeded):
        if (response.status === 429) {
          const canInlineWait =
            !retried429 &&
            attempt < attemptsLimit &&
            retryAfterMs > 0 &&
            retryAfterMs <= MAX_INLINE_429_WAIT_MS &&
            deadline - Date.now() > retryAfterMs + 1000 &&
            !signal?.aborted;

          if (canInlineWait) {
            retried429 = true;
            lastError = httpErr;
            pendingWaitMs = retryAfterMs;
            await sleepWithSignal(retryAfterMs, signal);
            continue;
          }

          if (modelName && modelName !== "GET /models") {
            const cooldownDuration =
              retryAfterMs > 0 ? retryAfterMs : DEFAULT_429_COOLDOWN_MS;
            setModelCooldown(effectiveProviderId, modelName, cooldownDuration, {
              isFreeTier
            });
          }
          throw httpErr;
        }

        // Xử lý 503 / 5xx:
        if (httpErr.retryable && attempt < attemptsLimit && !signal?.aborted) {
          const backoffMs = computeRetryBackoffMs(attempt, retryBaseDelayMs);
          if (deadline - Date.now() > backoffMs + 1000) {
            lastError = httpErr;
            pendingWaitMs = backoffMs;
            await sleepWithSignal(backoffMs, signal);
            continue;
          }
        }
        throw httpErr;
      }

      const json = await response.json();
      const extractedUsage =
        method === "POST"
          ? extractUsageFromResponse(json, effectiveProviderId)
          : null;

      if (Array.isArray(diagnostics)) {
        diagnostics.push({
          providerId: effectiveProviderId,
          model: modelName,
          attempt,
          status: response.status,
          durationMs: Date.now() - attemptStart,
          waitedMs: waitedBeforeThisAttempt,
          totalElapsedMs: Date.now() - startOverall,
          errorType: null,
          usage: extractedUsage
        });
      }
      return json;
    } catch (err) {
      const durationMs = Date.now() - attemptStart;

      if (signal?.aborted || err?.aborted) {
        throw new ProviderError("Đã hủy yêu cầu", { code: "ABORTED", aborted: true });
      }

      if (timedOut) {
        if (Array.isArray(diagnostics)) {
          diagnostics.push({
            providerId: effectiveProviderId,
            model: modelName,
            attempt,
            status: null,
            durationMs,
            waitedMs: waitedBeforeThisAttempt,
            totalElapsedMs: Date.now() - startOverall,
            errorType: "TIMEOUT"
          });
        }
        if (lastError && (lastError.status === 503 || lastError.code === "OVERLOADED")) {
          throw new ProviderError(
            "Máy chủ AI phản hồi chậm hoặc đang quá tải (503), vui lòng thử lại hoặc đổi model",
            {
              code: "OVERLOADED",
              status: 503,
              apiMessage: lastError.apiMessage,
              diagnostics: Array.isArray(diagnostics) ? diagnostics : []
            }
          );
        }
        throw new ProviderError("Hết thời gian chờ", {
          code: "TIMEOUT",
          retryable: false,
          diagnostics: Array.isArray(diagnostics) ? diagnostics : []
        });
      }

      if (err instanceof ProviderError) {
        lastError = err;
        throw err;
      }

      if (Array.isArray(diagnostics)) {
        diagnostics.push({
          providerId: effectiveProviderId,
          model: modelName,
          attempt,
          status: null,
          durationMs,
          waitedMs: waitedBeforeThisAttempt,
          totalElapsedMs: Date.now() - startOverall,
          errorType: "NETWORK"
        });
      }

      const netErr = new ProviderError("Không có kết nối mạng", {
        code: "NETWORK_ERROR",
        retryable: true,
        diagnostics: Array.isArray(diagnostics) ? diagnostics : []
      });
      lastError = netErr;

      if (attempt < attemptsLimit && !signal?.aborted) {
        const backoffMs = computeRetryBackoffMs(attempt, retryBaseDelayMs);
        if (deadline - Date.now() > backoffMs + 1000) {
          pendingWaitMs = backoffMs;
          await sleepWithSignal(backoffMs, signal);
          continue;
        }
      }
      throw netErr;
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  throw lastError || new ProviderError("Không có kết nối mạng", { code: "NETWORK_ERROR" });
}

export async function checkProviderModels({
  providerId,
  apiKey,
  fastModel,
  accurateModel,
  fallbackModel,
  signal,
  timeoutMs = 10000,
  diagnostics = null
}) {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) {
    throw new ProviderError("Chưa nhập API key, mở Options", { code: "NO_KEY" });
  }

  let url = "";
  let headers = {};

  if (providerId === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200";
    headers = { "x-goog-api-key": cleanKey };
  } else if (providerId === "openai") {
    url = "https://api.openai.com/v1/models";
    headers = { Authorization: `Bearer ${cleanKey}` };
  } else if (providerId === "anthropic") {
    url = "https://api.anthropic.com/v1/models?limit=100";
    headers = {
      "x-api-key": cleanKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
  } else if (providerId === "deepseek") {
    url = "https://api.deepseek.com/models";
    headers = { Authorization: `Bearer ${cleanKey}` };
  } else {
    return { checked: false, availableModels: [], missingModels: [], missingRoles: [], suggestions: [] };
  }

  const data = await fetchProviderJson({
    url,
    method: "GET",
    headers,
    signal,
    timeoutMs,
    maxAttempts: 1,
    apiKey: cleanKey,
    providerId,
    diagnostics,
    diagnosticLabel: "GET /models"
  });

  let modelIds = [];
  if (providerId === "gemini" && Array.isArray(data?.models)) {
    modelIds = data.models
      .filter(
        (m) =>
          !Array.isArray(m.supportedGenerationMethods) ||
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  } else if (Array.isArray(data?.data)) {
    modelIds = data.data.map((m) => String(m.id || "")).filter(Boolean);
  }

  if (modelIds.length === 0) {
    return { checked: true, availableModels: [], missingModels: [], missingRoles: [], suggestions: [] };
  }

  const availableSet = new Set(modelIds);
  const roleEntries = [
    { role: "fastModel", name: (fastModel || "").trim().replace(/^models\//, "") },
    { role: "accurateModel", name: (accurateModel || "").trim().replace(/^models\//, "") },
    { role: "fallbackModel", name: (fallbackModel || "").trim().replace(/^models\//, "") }
  ].filter((e) => Boolean(e.name));

  const missingModels = [];
  const missingRoles = [];

  for (const entry of roleEntries) {
    if (!availableSet.has(entry.name)) {
      if (!missingModels.includes(entry.name)) {
        missingModels.push(entry.name);
      }
      missingRoles.push(`${entry.role} (${entry.name})`);
    }
  }

  const suggestions = modelIds
    .filter((id) => /gemini|claude|gpt|deepseek/i.test(id))
    .slice(0, 6);

  let tierHint = "";
  if (providerId === "gemini") {
    tierHint = availableSet.has("gemini-4-argon")
      ? ""
      : "Lưu ý: Key Gemini trên gói Free tier có hạn mức RPM/RPD rất thấp; khuyến nghị bật Billing trong Google AI Studio.";
  }

  return {
    checked: true,
    availableModels: modelIds,
    missingModels,
    missingRoles,
    suggestions,
    tierHint
  };
}

export async function testProviderKeyOnly({
  providerId,
  apiKey,
  fastModel,
  accurateModel,
  fallbackModel,
  signal,
  timeoutMs = 10000
}) {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) {
    throw new ProviderError("Chưa nhập API key, mở Options", { code: "NO_KEY" });
  }

  const startTime = Date.now();
  const diagnostics = [];

  let modelCheck;
  try {
    modelCheck = await checkProviderModels({
      providerId,
      apiKey: cleanKey,
      fastModel,
      accurateModel,
      fallbackModel,
      signal,
      timeoutMs,
      diagnostics
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      err.diagnostics = diagnostics;
    }
    throw err;
  }

  const totalMs = Date.now() - startTime;
  const missingRoles = modelCheck.missingRoles || [];

  if (modelCheck.checked && missingRoles.length > 0) {
    const hint =
      modelCheck.suggestions.length > 0
        ? ` Gợi ý model khả dụng: ${modelCheck.suggestions.join(", ")}.`
        : "";
    return {
      ok: true,
      state: "warn",
      keyValid: true,
      latencyMs: totalMs,
      message: `Key hợp lệ (${totalMs}ms), nhưng phát hiện model không có trong danh sách của key (sẽ gây lỗi 404): ${missingRoles.join(", ")}.${hint}`,
      modelCheck,
      diagnostics
    };
  }

  const tierExtra = modelCheck.tierHint ? ` (${modelCheck.tierHint})` : "";
  return {
    ok: true,
    state: "ok",
    keyValid: true,
    latencyMs: totalMs,
    message: `Key hợp lệ (${totalMs}ms) — Đã đối chiếu danh sách model (không tốn quota generateContent).${tierExtra}`,
    modelCheck,
    diagnostics
  };
}

async function probeSingleModel({
  providerId,
  apiKey,
  model,
  signal,
  timeoutMs = 10000,
  diagnostics = null
}) {
  const cleanModel = (model || "").trim().replace(/^models\//, "");

  if (providerId === "gemini") {
    const target = cleanModel || "gemini-3.8-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(target)}:generateContent`;
    const headers = {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    };
    try {
      await fetchProviderJson({
        url,
        headers,
        body: {
          contents: [{ role: "user", parts: [{ text: "Reply OK" }] }],
          generationConfig: {
            maxOutputTokens: 16,
            thinkingConfig: { thinkingLevel: "low" }
          }
        },
        signal,
        timeoutMs,
        maxAttempts: 1,
        apiKey,
        providerId,
        diagnostics,
        diagnosticLabel: target
      });
    } catch (err) {
      if (isParameterCompatibilityError(err) && !signal?.aborted) {
        await fetchProviderJson({
          url,
          headers,
          body: {
            contents: [{ role: "user", parts: [{ text: "Reply OK" }] }],
            generationConfig: { maxOutputTokens: 16 }
          },
          signal,
          timeoutMs: Math.max(3000, Math.floor(timeoutMs / 2)),
          maxAttempts: 1,
          apiKey,
          providerId,
          diagnostics,
          diagnosticLabel: `${target} (compat)`
        });
      } else {
        throw err;
      }
    }
    return;
  }

  if (providerId === "openai") {
    const target = cleanModel || "gpt-6-luna";
    const url = "https://api.openai.com/v1/chat/completions";
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };
    try {
      await fetchProviderJson({
        url,
        headers,
        body: {
          model: target,
          messages: [{ role: "user", content: "Reply OK" }],
          max_completion_tokens: 16,
          reasoning_effort: "low"
        },
        signal,
        timeoutMs,
        maxAttempts: 1,
        apiKey,
        providerId,
        diagnostics,
        diagnosticLabel: target
      });
    } catch (err) {
      if (isParameterCompatibilityError(err) && !signal?.aborted) {
        await fetchProviderJson({
          url,
          headers,
          body: {
            model: target,
            messages: [{ role: "user", content: "Reply OK" }],
            max_tokens: 16
          },
          signal,
          timeoutMs: Math.max(3000, Math.floor(timeoutMs / 2)),
          maxAttempts: 1,
          apiKey,
          providerId,
          diagnostics,
          diagnosticLabel: `${target} (compat)`
        });
      } else {
        throw err;
      }
    }
    return;
  }

  if (providerId === "anthropic") {
    const target = cleanModel || "claude-haiku-5-5";
    const url = "https://api.anthropic.com/v1/messages";
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    try {
      await fetchProviderJson({
        url,
        headers,
        body: {
          model: target,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply OK" }],
          output_config: { effort: "low" }
        },
        signal,
        timeoutMs,
        maxAttempts: 1,
        apiKey,
        providerId,
        diagnostics,
        diagnosticLabel: target
      });
    } catch (err) {
      if (isParameterCompatibilityError(err) && !signal?.aborted) {
        await fetchProviderJson({
          url,
          headers,
          body: {
            model: target,
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply OK" }]
          },
          signal,
          timeoutMs: Math.max(3000, Math.floor(timeoutMs / 2)),
          maxAttempts: 1,
          apiKey,
          providerId,
          diagnostics,
          diagnosticLabel: `${target} (compat)`
        });
      } else {
        throw err;
      }
    }
    return;
  }

  if (providerId === "deepseek") {
    const target = cleanModel || "deepseek-flash";
    const url = "https://api.deepseek.com/chat/completions";
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };
    try {
      await fetchProviderJson({
        url,
        headers,
        body: {
          model: target,
          messages: [{ role: "user", content: "Reply OK" }],
          max_tokens: 16,
          thinking: { type: "disabled" }
        },
        signal,
        timeoutMs,
        maxAttempts: 1,
        apiKey,
        providerId,
        diagnostics,
        diagnosticLabel: target
      });
    } catch (err) {
      if (isParameterCompatibilityError(err) && !signal?.aborted) {
        await fetchProviderJson({
          url,
          headers,
          body: {
            model: target,
            messages: [{ role: "user", content: "Reply OK" }],
            max_tokens: 16
          },
          signal,
          timeoutMs: Math.max(3000, Math.floor(timeoutMs / 2)),
          maxAttempts: 1,
          apiKey,
          providerId,
          diagnostics,
          diagnosticLabel: `${target} (compat)`
        });
      } else {
        throw err;
      }
    }
  }
}

export async function probeProviderModel({
  providerId,
  apiKey,
  model,
  signal,
  timeoutMs = 10000
}) {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) {
    throw new ProviderError("Chưa nhập API key, mở Options", { code: "NO_KEY" });
  }

  await loadCooldownsFromSessionStorage();
  const targetModel = (model || "").trim().replace(/^models\//, "");
  const cooldown = getModelCooldownEntry(providerId, targetModel);
  if (cooldown) {
    return {
      ok: true,
      state: "warn",
      modelBusy: true,
      cooldownSec: cooldown.remainingSec,
      testedModel: targetModel,
      message: `Model "${targetModel}" vừa chạm hạn mức (429), đang tạm khóa phía client để tránh tốn quota. Thử lại sau ${cooldown.remainingSec} giây.`,
      diagnostics: [
        {
          providerId,
          model: targetModel,
          skipped: true,
          cooldownSec: cooldown.remainingSec
        }
      ]
    };
  }

  const startTime = Date.now();
  const diagnostics = [];

  try {
    await probeSingleModel({
      providerId,
      apiKey: cleanKey,
      model: targetModel,
      signal,
      timeoutMs,
      diagnostics
    });
    const totalMs = Date.now() - startTime;
    return {
      ok: true,
      state: "ok",
      modelBusy: false,
      latencyMs: totalMs,
      testedModel: targetModel,
      message: `Model "${targetModel}" phản hồi tốt (${totalMs}ms).`,
      diagnostics
    };
  } catch (err) {
    const totalMs = Date.now() - startTime;
    if (
      err instanceof ProviderError &&
      (err.code === "OVERLOADED" || err.code === "RATE_LIMIT" || err.code === "SERVER_ERROR")
    ) {
      return {
        ok: true,
        state: "warn",
        modelBusy: true,
        latencyMs: totalMs,
        testedModel: targetModel,
        message: err.message,
        diagnostics
      };
    }
    if (err instanceof ProviderError) {
      err.diagnostics = diagnostics;
    }
    throw err;
  }
}

export async function testProviderConnection({
  providerId,
  apiKey,
  fastModel,
  accurateModel,
  fallbackModel,
  probeModel = false,
  signal,
  timeoutMs = 10000
}) {
  const keyResult = await testProviderKeyOnly({
    providerId,
    apiKey,
    fastModel,
    accurateModel,
    fallbackModel,
    signal,
    timeoutMs
  });

  if (!probeModel) {
    return keyResult;
  }

  const probeRes = await probeProviderModel({
    providerId,
    apiKey,
    model: fastModel,
    signal,
    timeoutMs
  });

  return {
    ...probeRes,
    keyValid: true,
    modelCheck: keyResult.modelCheck,
    diagnostics: [...(keyResult.diagnostics || []), ...(probeRes.diagnostics || [])]
  };
}

const PROVIDERS = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  deepseek: deepseekProvider
};

export function getProvider(providerId) {
  return PROVIDERS[providerId] || PROVIDERS.anthropic;
}

/**
 * Giải câu hỏi với chuỗi dự phòng tiết kiệm request & nhận diện hết credit (INSUFFICIENT_QUOTA):
 * - Nếu gặp INSUFFICIENT_QUOTA (hết credit), KHÔNG gọi fallbackModel cùng provider, chỉ thử provider khác nếu bật dự phòng chéo.
 * - Trả về thống kê usage (inputTokens, outputTokens, reasoningTokens, cachedTokens) để ghi nhận chi tiêu cục bộ.
 */
export async function solveWithProviderDetailed({
  providerId,
  imageDataUrl,
  mode = "fast",
  config = {},
  signal
}) {
  await loadCooldownsFromSessionStorage();

  const diagnostics = Array.isArray(config.diagnostics) ? config.diagnostics : [];
  const primaryModel =
    (config.targetModel ||
      (mode === "accurate" ? config.accurateModel : config.fastModel) ||
      "")?.trim();

  const fallbackModel = (config.fallbackModel ?? "").trim();
  const allowSameProviderFallback =
    config.enableModelFallback !== false &&
    Boolean(fallbackModel) &&
    fallbackModel !== primaryModel;

  const allowCrossProviderFallback = Boolean(config.enableCrossProviderFallback);
  const allProvidersConfig = config.allProvidersConfig || {};
  const crossProviderOrder = Array.isArray(config.crossProviderOrder)
    ? config.crossProviderOrder
    : ["anthropic", "openai", "deepseek", "gemini"];

  const candidates = [];
  if (primaryModel) {
    candidates.push({
      providerId,
      model: primaryModel,
      providerConfig: config,
      isFallback: false,
      isCrossProvider: false
    });
  }

  if (allowSameProviderFallback) {
    candidates.push({
      providerId,
      model: fallbackModel,
      providerConfig: config,
      isFallback: true,
      isCrossProvider: false
    });
  }

  if (allowCrossProviderFallback) {
    for (const otherId of crossProviderOrder) {
      if (otherId === providerId || !PROVIDERS[otherId]) continue;
      const otherCfg = allProvidersConfig[otherId];
      if (!otherCfg || !otherCfg.apiKey || !otherCfg.apiKey.trim()) continue;
      const otherModel =
        (mode === "accurate" ? otherCfg.accurateModel : otherCfg.fastModel)?.trim() ||
        PROVIDER_META[otherId]?.defaultFastModel;
      if (otherModel) {
        candidates.push({
          providerId: otherId,
          model: otherModel,
          providerConfig: {
            ...otherCfg,
            customPrompt: config.customPrompt,
            domText: config.domText
          },
          isFallback: true,
          isCrossProvider: true
        });
      }
    }
  }

  const totalBudgetMs =
    typeof config.timeoutMs === "number" && config.timeoutMs > 0
      ? config.timeoutMs
      : mode === "accurate"
        ? 60000
        : 30000;

  const startOverall = Date.now();
  let lastError = null;
  let longestCooldownEntry = null;
  const exhaustedCreditProviders = new Set();

  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx];
    const hasMoreCandidates = idx < candidates.length - 1;

    // Nếu provider này vừa báo hết credit (insufficient_quota), bỏ qua ngay mọi model cùng provider!
    if (exhaustedCreditProviders.has(candidate.providerId)) {
      continue;
    }

    const cooldown = getModelCooldownEntry(candidate.providerId, candidate.model);
    if (cooldown) {
      diagnostics.push({
        providerId: candidate.providerId,
        model: candidate.model,
        skipped: true,
        cooldownSec: cooldown.remainingSec
      });
      if (
        !longestCooldownEntry ||
        cooldown.remainingSec > longestCooldownEntry.remainingSec
      ) {
        longestCooldownEntry = {
          ...cooldown,
          providerId: candidate.providerId,
          model: candidate.model
        };
      }
      continue;
    }

    const remainingTotalMs = totalBudgetMs - (Date.now() - startOverall);
    if (remainingTotalMs <= 500) {
      break;
    }

    const candidateTimeoutMs = hasMoreCandidates
      ? Math.max(4000, Math.floor(remainingTotalMs * 0.65))
      : remainingTotalMs;

    const candidateMaxAttempts =
      typeof config.maxAttempts === "number" ? config.maxAttempts : 2;

    const targetProvider = getProvider(candidate.providerId);

    try {
      const text = await targetProvider.solve({
        imageDataUrl,
        mode,
        config: {
          ...candidate.providerConfig,
          targetModel: candidate.model,
          timeoutMs: candidateTimeoutMs,
          maxAttempts: candidateMaxAttempts,
          diagnostics
        },
        signal
      });

      const stats = summarizeDiagnostics(diagnostics);
      return {
        text,
        usedProviderId: candidate.providerId,
        usedProviderName:
          PROVIDER_META[candidate.providerId]?.shortName || candidate.providerId,
        usedModel: candidate.model,
        usedFallback: candidate.isFallback,
        usedCrossProvider: candidate.isCrossProvider,
        primaryModel,
        totalRequests: stats.totalRequests,
        byModel: stats.byModel,
        usage: stats.usage,
        diagnostics
      };
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError && err.code === "INSUFFICIENT_QUOTA") {
        // Đánh dấu provider này đã hết sạch credit -> không thử fallbackModel cùng provider nữa
        exhaustedCreditProviders.add(candidate.providerId);
        if (allowCrossProviderFallback && hasMoreCandidates) {
          continue;
        }
        break;
      }
      if (signal?.aborted || err?.aborted || !hasMoreCandidates || !isOverloadOrServerError(err)) {
        break;
      }
    }
  }

  if (!lastError && longestCooldownEntry) {
    const pName =
      PROVIDER_META[longestCooldownEntry.providerId]?.shortName ||
      longestCooldownEntry.providerId;
    const billingHint =
      longestCooldownEntry.providerId === "gemini" ? " hoặc bật billing" : "";
    throw new ProviderError(
      `Đang chờ hồi hạn mức ${pName} (${longestCooldownEntry.model}), thử lại sau ${longestCooldownEntry.remainingSec} giây${billingHint}`,
      {
        code: "COOLDOWN",
        status: 429,
        retryAfterMs: longestCooldownEntry.remainingMs,
        diagnostics
      }
    );
  }

  if (lastError) {
    lastError.diagnostics = diagnostics;
    throw lastError;
  }

  throw new ProviderError("Không thể gọi model AI", { diagnostics });
}

export async function solveWithProvider({
  providerId,
  imageDataUrl,
  mode,
  config,
  signal
}) {
  const res = await solveWithProviderDetailed({
    providerId,
    imageDataUrl,
    mode,
    config,
    signal
  });
  return res.text;
}
