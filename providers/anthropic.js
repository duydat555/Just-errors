import { buildPrompts } from "../lib/prompt.js";
import {
  ProviderError,
  extractBase64Image,
  fetchProviderJson,
  isParameterCompatibilityError
} from "./index.js";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";

function supportsServerSideFallback(model) {
  return (
    model === "claude-opus-5-5" ||
    model === "claude-opus-5" ||
    model === "claude-sonnet-5-5" ||
    model === "claude-fable-5-1"
  );
}

/**
 * Gọi Anthropic Messages API để giải câu hỏi trắc nghiệm.
 * - Bật cache_control: { type: "ephemeral" } trên system prompt cố định ở đầu request.
 * - Kiểm tra stop_reason === "max_tokens" để báo rõ nếu phản hồi bị cắt cụt.
 */
export async function solve({ imageDataUrl, mode = "fast", config = {}, signal }) {
  const apiKey = (config.apiKey || "").trim();
  if (!apiKey) {
    throw new ProviderError("Chưa nhập API key, mở Options", { code: "NO_KEY" });
  }

  const model =
    (config.targetModel ||
      (mode === "accurate" ? config.accurateModel : config.fastModel))?.trim() ||
    (mode === "accurate" ? "claude-opus-5-5" : "claude-haiku-5-5");

  const hasDomText = Boolean(config.domText && config.domText.trim());
  const { systemPrompt, userPrompt } = buildPrompts({
    mode,
    customPrompt: config.customPrompt,
    domText: config.domText
  });

  const userContent = [];
  if (!hasDomText && imageDataUrl) {
    const { mimeType, data } = extractBase64Image(imageDataUrl);
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data
      }
    });
  }
  userContent.push({
    type: "text",
    text: userPrompt
  });

  const baseHeaders = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };

  const useFallbackBeta = supportsServerSideFallback(model);
  const headers = useFallbackBeta
    ? { ...baseHeaders, "anthropic-beta": "server-side-fallback-2026-07-01" }
    : baseHeaders;

  const maxOutputTokens = mode === "accurate" ? 8192 : 2048;

  const primaryBody = {
    model,
    max_tokens: maxOutputTokens,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [
      {
        role: "user",
        content: userContent
      }
    ],
    output_config: {
      effort: mode === "accurate" ? "high" : "low"
    }
  };

  if (mode === "accurate") {
    primaryBody.thinking = { type: "adaptive" };
  }
  if (useFallbackBeta) {
    primaryBody.fallbacks = "default";
  }

  const maxAttempts = typeof config.maxAttempts === "number" ? config.maxAttempts : 2;
  const retryBaseDelayMs =
    typeof config.retryBaseDelayMs === "number" ? config.retryBaseDelayMs : 1000;

  let data;
  try {
    data = await fetchProviderJson({
      url: ANTHROPIC_ENDPOINT,
      headers,
      body: primaryBody,
      mode,
      signal,
      timeoutMs: config.timeoutMs,
      maxAttempts,
      retryBaseDelayMs,
      apiKey,
      providerId: "anthropic",
      diagnostics: config.diagnostics,
      diagnosticLabel: model
    });
  } catch (err) {
    if (isParameterCompatibilityError(err) && !signal?.aborted) {
      const fallbackBody = {
        model,
        max_tokens: maxOutputTokens,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userContent
          }
        ]
      };
      data = await fetchProviderJson({
        url: ANTHROPIC_ENDPOINT,
        headers: baseHeaders,
        body: fallbackBody,
        mode,
        signal,
        timeoutMs: config.timeoutMs,
        maxAttempts: 1,
        retryBaseDelayMs,
        apiKey,
        providerId: "anthropic",
        diagnostics: config.diagnostics,
        diagnosticLabel: `${model} (compat)`
      });
    } else {
      throw err;
    }
  }

  if (data && data.stop_reason === "refusal") {
    throw new ProviderError("AI từ chối trả lời nội dung này", { code: "REFUSAL" });
  }

  if (data && data.stop_reason === "max_tokens") {
    throw new ProviderError(
      "Phản hồi AI bị cắt do chạm giới hạn token đầu ra, bấm Giải lại để thử lại",
      { code: "TRUNCATED_OUTPUT", retryable: false }
    );
  }

  const contentBlocks = Array.isArray(data?.content) ? data.content : [];
  const text = contentBlocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new ProviderError("Không đọc được phản hồi AI", { code: "EMPTY_RESPONSE" });
  }

  return text;
}
