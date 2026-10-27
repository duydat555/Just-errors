import { buildPrompts } from "../lib/prompt.js";
import {
  ProviderError,
  fetchProviderJson,
  isParameterCompatibilityError
} from "./index.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

/**
 * Chuẩn hóa reasoning_effort cho OpenAI:
 * Model gpt-6.1-sol và gpt-6-astra KHÔNG hỗ trợ "none" hoặc "minimal" (trả lỗi HTTP 400).
 * Do đó chế độ Nhanh luôn dùng "low" và chế độ Chính xác luôn dùng "high".
 */
export function resolveOpenAiReasoningEffort(mode = "fast") {
  return mode === "accurate" ? "high" : "low";
}

/**
 * Gọi OpenAI Chat Completions API để giải câu hỏi trắc nghiệm.
 * - Đặt toàn bộ system prompt cố định ở đầu (messages[0]) để tối ưu Prompt Caching.
 * - Đặt max_completion_tokens = 25000 cho chế độ Chính xác (đủ cho cả reasoning_tokens mức high
 *   lẫn JSON đầu ra mà không bị cắt cụt giữa chừng; OpenAI chỉ tính tiền số token thực sự sinh ra)
 *   và 4096 cho chế độ Nhanh.
 * - Giữ nguyên phát hiện phản hồi bị cắt (finish_reason === "length" / incomplete).
 */
export async function solve({ imageDataUrl, mode = "fast", config = {}, signal }) {
  const apiKey = (config.apiKey || "").trim();
  if (!apiKey) {
    throw new ProviderError("Chưa nhập API key, mở Options", { code: "NO_KEY" });
  }

  const model =
    (config.targetModel ||
      (mode === "accurate" ? config.accurateModel : config.fastModel))?.trim() ||
    (mode === "accurate" ? "gpt-6-astra" : "gpt-6-luna");

  const hasDomText = Boolean(config.domText && config.domText.trim());
  const { systemPrompt, userPrompt } = buildPrompts({
    mode,
    customPrompt: config.customPrompt,
    domText: config.domText
  });

  const userContent = [];
  if (!hasDomText && imageDataUrl) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: imageDataUrl,
        detail: mode === "accurate" ? "high" : "low"
      }
    });
  }
  userContent.push({
    type: "text",
    text: userPrompt
  });

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  // Phần cố định (systemPrompt) đứng đầu mảng messages, không chứa bất kỳ biến động nào
  const baseMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  const maxOutputTokens = mode === "accurate" ? 25000 : 4096;
  const reasoningEffort = resolveOpenAiReasoningEffort(mode);

  const primaryBody = {
    model,
    messages: baseMessages,
    max_completion_tokens: maxOutputTokens,
    reasoning_effort: reasoningEffort,
    response_format: { type: "json_object" }
  };

  const maxAttempts = typeof config.maxAttempts === "number" ? config.maxAttempts : 2;
  const retryBaseDelayMs =
    typeof config.retryBaseDelayMs === "number" ? config.retryBaseDelayMs : 1000;

  let data;
  try {
    data = await fetchProviderJson({
      url: OPENAI_ENDPOINT,
      headers,
      body: primaryBody,
      mode,
      signal,
      timeoutMs: config.timeoutMs,
      maxAttempts,
      retryBaseDelayMs,
      apiKey,
      providerId: "openai",
      diagnostics: config.diagnostics,
      diagnosticLabel: model
    });
  } catch (err) {
    if (isParameterCompatibilityError(err) && !signal?.aborted) {
      const fallbackBody = {
        model,
        messages: baseMessages,
        max_tokens: mode === "accurate" ? 8192 : 2048
      };
      data = await fetchProviderJson({
        url: OPENAI_ENDPOINT,
        headers,
        body: fallbackBody,
        mode,
        signal,
        timeoutMs: config.timeoutMs,
        maxAttempts: 1,
        retryBaseDelayMs,
        apiKey,
        providerId: "openai",
        diagnostics: config.diagnostics,
        diagnosticLabel: `${model} (compat)`
      });
    } else {
      throw err;
    }
  }

  const choice = data?.choices?.[0];
  if (
    choice?.finish_reason === "length" ||
    data?.status === "incomplete" ||
    data?.incomplete_details?.reason === "max_output_tokens"
  ) {
    throw new ProviderError(
      "Phản hồi AI bị cắt do chạm giới hạn token đầu ra, bấm Giải lại để thử lại",
      { code: "TRUNCATED_OUTPUT", retryable: false }
    );
  }

  const msg = choice?.message;
  let text = "";
  if (typeof msg?.content === "string") {
    text = msg.content.trim();
  } else if (Array.isArray(msg?.content)) {
    text = msg.content
      .filter((part) => part && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }

  if (!text) {
    throw new ProviderError("Không đọc được phản hồi AI", { code: "EMPTY_RESPONSE" });
  }

  return text;
}
