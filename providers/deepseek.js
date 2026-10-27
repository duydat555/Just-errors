import { buildPrompts } from "../lib/prompt.js";
import {
  ProviderError,
  fetchProviderJson,
  isParameterCompatibilityError
} from "./index.js";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

function isTextOnlyDeepSeekModel(model) {
  const m = (model || "").toLowerCase();
  return (
    m.includes("v4-pro") ||
    m === "deepseek-chat" ||
    m === "deepseek-reasoner"
  );
}

export async function solve({ imageDataUrl, mode = "fast", config = {}, signal }) {
  const apiKey = (config.apiKey || "").trim();
  if (!apiKey) {
    throw new ProviderError("Chưa nhập API key, mở Options", { code: "NO_KEY" });
  }

  const configuredModel =
    (config.targetModel ||
      (mode === "accurate" ? config.accurateModel : config.fastModel))?.trim() ||
    "deepseek-flash";

  const hasDomText = Boolean(config.domText && config.domText.trim());

  if (!hasDomText && imageDataUrl && isTextOnlyDeepSeekModel(configuredModel)) {
    throw new ProviderError(
      `Model ${configuredModel} chỉ nhận văn bản (hãy chọn deepseek-flash hoặc bật Trích xuất DOM trong Options)`,
      { code: "VISION_NOT_SUPPORTED", retryable: false }
    );
  }

  const { systemPrompt, userPrompt } = buildPrompts({
    mode,
    customPrompt: config.customPrompt,
    domText: config.domText
  });

  let userContent;
  if (!hasDomText && imageDataUrl) {
    userContent = [
      {
        type: "image_url",
        image_url: {
          url: imageDataUrl,
          detail: mode === "accurate" ? "high" : "low"
        }
      },
      {
        type: "text",
        text: userPrompt
      }
    ];
  } else {
    userContent = userPrompt;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  const baseMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  const maxOutputTokens = mode === "accurate" ? 8192 : 2048;

  const primaryBody = {
    model: configuredModel,
    messages: baseMessages,
    max_tokens: maxOutputTokens,
    thinking: {
      type: mode === "accurate" ? "enabled" : "disabled"
    },
    ...(mode === "accurate" ? { reasoning_effort: "high" } : {})
  };

  const maxAttempts = typeof config.maxAttempts === "number" ? config.maxAttempts : 2;
  const retryBaseDelayMs =
    typeof config.retryBaseDelayMs === "number" ? config.retryBaseDelayMs : 1000;

  let data;
  try {
    data = await fetchProviderJson({
      url: DEEPSEEK_ENDPOINT,
      headers,
      body: primaryBody,
      mode,
      signal,
      timeoutMs: config.timeoutMs,
      maxAttempts,
      retryBaseDelayMs,
      apiKey,
      providerId: "deepseek",
      diagnostics: config.diagnostics,
      diagnosticLabel: configuredModel
    });
  } catch (err) {
    if (isParameterCompatibilityError(err) && !signal?.aborted) {
      const fallbackBody = {
        model: configuredModel,
        messages: baseMessages,
        max_tokens: maxOutputTokens
      };
      data = await fetchProviderJson({
        url: DEEPSEEK_ENDPOINT,
        headers,
        body: fallbackBody,
        mode,
        signal,
        timeoutMs: config.timeoutMs,
        maxAttempts: 1,
        retryBaseDelayMs,
        apiKey,
        providerId: "deepseek",
        diagnostics: config.diagnostics,
        diagnosticLabel: `${configuredModel} (compat)`
      });
    } else {
      throw err;
    }
  }

  const choice = data?.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new ProviderError(
      "Phản hồi AI bị cắt do chạm giới hạn token đầu ra, bấm Giải lại để thử lại",
      { code: "TRUNCATED_OUTPUT", retryable: false }
    );
  }

  const text = (choice?.message?.content || "").trim();
  if (!text) {
    throw new ProviderError("Không đọc được phản hồi AI", { code: "EMPTY_RESPONSE" });
  }

  return text;
}
