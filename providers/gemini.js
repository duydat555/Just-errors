import { buildPrompts } from "../lib/prompt.js";
import {
  ProviderError,
  extractBase64Image,
  fetchProviderJson,
  isParameterCompatibilityError
} from "./index.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gọi Google Gemini generateContent API để giải câu hỏi trắc nghiệm.
 * - Đặt maxOutputTokens hợp lý (2048 cho Nhanh, 8192 cho Chính xác) và phát hiện nếu bị cắt (finishReason === "MAX_TOKENS").
 */
export async function solve({ imageDataUrl, mode = "fast", config = {}, signal }) {
  const apiKey = (config.apiKey || "").trim();
  if (!apiKey) {
    throw new ProviderError("Chưa nhập API key, mở Options", { code: "NO_KEY" });
  }

  const rawModel =
    (config.targetModel ||
      (mode === "accurate" ? config.accurateModel : config.fastModel))?.trim() ||
    (mode === "accurate" ? "gemini-4-argon" : "gemini-3.8-flash");
  const model = rawModel.replace(/^models\//, "");

  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`;

  const hasDomText = Boolean(config.domText && config.domText.trim());
  const { systemPrompt, userPrompt } = buildPrompts({
    mode,
    customPrompt: config.customPrompt,
    domText: config.domText
  });

  const parts = [];
  if (!hasDomText && imageDataUrl) {
    const { mimeType, data } = extractBase64Image(imageDataUrl);
    parts.push({
      inlineData: {
        mimeType,
        data
      }
    });
  }
  parts.push({ text: userPrompt });

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey
  };

  const maxOutputTokens = mode === "accurate" ? 8192 : 2048;

  const primaryBody = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens,
      thinkingConfig: {
        thinkingLevel: mode === "accurate" ? "high" : "low"
      }
    }
  };

  const maxAttempts = typeof config.maxAttempts === "number" ? config.maxAttempts : 2;
  const retryBaseDelayMs =
    typeof config.retryBaseDelayMs === "number" ? config.retryBaseDelayMs : 1000;

  let data;
  try {
    data = await fetchProviderJson({
      url,
      headers,
      body: primaryBody,
      mode,
      signal,
      timeoutMs: config.timeoutMs,
      maxAttempts,
      retryBaseDelayMs,
      apiKey,
      providerId: "gemini",
      diagnostics: config.diagnostics,
      diagnosticLabel: model
    });
  } catch (err) {
    if (isParameterCompatibilityError(err) && !signal?.aborted) {
      const fallbackBody = {
        systemInstruction: primaryBody.systemInstruction,
        contents: primaryBody.contents,
        generationConfig: {
          maxOutputTokens
        }
      };
      data = await fetchProviderJson({
        url,
        headers,
        body: fallbackBody,
        mode,
        signal,
        timeoutMs: config.timeoutMs,
        maxAttempts: 1,
        retryBaseDelayMs,
        apiKey,
        providerId: "gemini",
        diagnostics: config.diagnostics,
        diagnosticLabel: `${model} (compat)`
      });
    } else {
      throw err;
    }
  }

  const candidate = data?.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new ProviderError(
      "Phản hồi AI bị cắt do chạm giới hạn token đầu ra, bấm Giải lại để thử lại",
      { code: "TRUNCATED_OUTPUT", retryable: false }
    );
  }

  const candidateParts = candidate?.content?.parts;
  if (!Array.isArray(candidateParts) || candidateParts.length === 0) {
    throw new ProviderError("Không đọc được phản hồi AI", { code: "EMPTY_RESPONSE" });
  }

  const text = candidateParts
    .filter((p) => p && !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new ProviderError("Không đọc được phản hồi AI", { code: "EMPTY_RESPONSE" });
  }

  return text;
}
