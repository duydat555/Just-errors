const VALID_ANSWERS = new Set(["A", "B", "C", "D"]);
export const SEPARATOR = "·"; // Dấu chấm giữa "·" (U+00B7)
export const NO_COMPLETE_MESSAGE = "Không thấy câu hoàn chỉnh";
export const PARSE_ERROR_MESSAGE = "Không đọc được phản hồi AI";

/**
 * Trích xuất đối tượng JSON từ chuỗi phản hồi của AI một cách chịu lỗi:
 * - Bỏ markdown code fence (```json ... ```)
 * - Bỏ văn bản thừa trước/sau
 * - Tìm các khối {...} cân bằng ngoài cùng và thử JSON.parse
 */
export function extractJsonObject(rawText) {
  if (typeof rawText !== "string") return null;

  const trimmed = rawText.trim();
  if (!trimmed) return null;

  // 1. Thử parse trực tiếp
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct;
    }
  } catch (_) {}

  // 2. Bỏ hàng rào ```json ... ``` nếu có
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsedFence = JSON.parse(fenceStripped);
    if (parsedFence && typeof parsedFence === "object" && !Array.isArray(parsedFence)) {
      return parsedFence;
    }
  } catch (_) {}

  // 3. Quét các cặp ngoặc nhọn {...} cân bằng ngoài cùng (bỏ qua dấu { } nằm trong chuỗi JSON)
  const candidates = [];
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        startIdx = i;
      }
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          candidates.push(trimmed.slice(startIdx, i + 1));
          startIdx = -1;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && Array.isArray(obj.questions)) {
        return obj;
      }
    } catch (_) {}
  }

  // Fallback: thử từ dấu '{' đầu tiên tới dấu '}' cuối cùng
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const obj = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Lớp bảo vệ 2:
 * - Chỉ giữ câu có complete === true và answer thuộc {A, B, C, D}
 * - Loại câu trùng số (giữ câu xuất hiện đầu tiên)
 * - Sắp xếp theo number tăng dần
 */
export function filterValidQuestions(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.questions)) {
    return null;
  }

  const seenNumbers = new Set();
  const valid = [];

  for (const item of parsed.questions) {
    if (!item || typeof item !== "object") continue;

    // Bắt buộc complete === true (boolean)
    if (item.complete !== true) continue;

    // Chuẩn hóa số câu
    const num = typeof item.number === "number"
      ? item.number
      : typeof item.number === "string" && /^\d+$/.test(item.number.trim())
        ? Number.parseInt(item.number.trim(), 10)
        : NaN;

    if (!Number.isInteger(num) || num <= 0) continue;

    // Chuẩn hóa đáp án: chữ hoa, bỏ khoảng trắng, chỉ nhận A/B/C/D
    if (typeof item.answer !== "string") continue;
    const normalizedAnswer = item.answer.trim().toUpperCase();
    if (!VALID_ANSWERS.has(normalizedAnswer)) continue;

    // Loại trùng số câu (giữ câu đầu tiên)
    if (seenNumbers.has(num)) continue;
    seenNumbers.add(num);

    valid.push({
      number: num,
      answer: normalizedAnswer
    });
  }

  valid.sort((a, b) => a.number - b.number);
  return valid;
}

/**
 * Định dạng danh sách câu hợp lệ thành chuỗi "1A·2D·3B".
 */
export function formatQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return NO_COMPLETE_MESSAGE;
  }
  return questions.map((q) => `${q.number}${q.answer}`).join(SEPARATOR);
}

/**
 * Hàm tổng hợp: nhận chuỗi phản hồi AI -> trả về kết quả đã lọc và định dạng.
 */
export function parseAiResponse(rawText) {
  const obj = extractJsonObject(rawText);
  const questions = filterValidQuestions(obj);
  if (questions === null) {
    return {
      ok: false,
      error: PARSE_ERROR_MESSAGE,
      questions: [],
      formatted: ""
    };
  }

  return {
    ok: true,
    error: null,
    questions,
    formatted: formatQuestions(questions)
  };
}

/**
 * Kết hợp nhiều lần chạy (chế độ Chính xác chạy 2 lần lấy đa số).
 * Với mỗi số câu:
 * - Nếu xuất hiện ở nhiều lần chạy, chọn đáp án có số phiếu cao nhất (hòa thì ưu tiên lần chạy 1).
 * - Chỉ giữ câu được xác nhận hoàn chỉnh ở ít nhất 1 lần chạy (nếu cả 2 lần đều có câu hoàn chỉnh,
 *   ưu tiên các câu xuất hiện ở cả 2 lần; nếu giao rỗng thì hợp).
 */
export function mergeMajorityQuestions(runsQuestions) {
  const validRuns = runsQuestions.filter((r) => Array.isArray(r) && r.length > 0);
  if (validRuns.length === 0) return [];
  if (validRuns.length === 1) return validRuns[0];

  const votesByNumber = new Map();
  for (const run of validRuns) {
    for (const q of run) {
      if (!votesByNumber.has(q.number)) {
        votesByNumber.set(q.number, []);
      }
      votesByNumber.get(q.number).push(q.answer);
    }
  }

  // Kiểm tra xem có câu nào xuất hiện ở đa số lần chạy không
  const minCount = Math.ceil(validRuns.length / 2);
  let numbers = Array.from(votesByNumber.keys()).filter(
    (num) => votesByNumber.get(num).length >= minCount
  );
  if (numbers.length === 0) {
    numbers = Array.from(votesByNumber.keys());
  }
  numbers.sort((a, b) => a - b);

  return numbers.map((num) => {
    const answers = votesByNumber.get(num);
    const counts = new Map();
    for (const ans of answers) {
      counts.set(ans, (counts.get(ans) || 0) + 1);
    }
    let bestAns = answers[0];
    let bestCount = 0;
    for (const [ans, count] of counts.entries()) {
      if (count > bestCount) {
        bestAns = ans;
        bestCount = count;
      }
    }
    return { number: num, answer: bestAns };
  });
}
