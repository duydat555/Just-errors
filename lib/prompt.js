export const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          complete: { type: "boolean" },
          answer: {
            type: ["string", "null"],
            enum: ["A", "B", "C", "D", null]
          }
        },
        required: ["number", "complete", "answer"],
        additionalProperties: false
      }
    }
  },
  required: ["questions"],
  additionalProperties: false
};

const BASE_SYSTEM_PROMPT =
  "Bạn nhận một ảnh chụp màn hình chứa các câu hỏi trắc nghiệm với đáp án A, B, C, D. " +
  "Với mỗi câu nhìn thấy, đặt `complete: true` CHỈ KHI thấy đầy đủ nội dung câu hỏi và cả bốn đáp án A, B, C, D, không bị cắt ở mép trên hoặc mép dưới của ảnh. " +
  "Câu chỉ thấy đề mà chưa thấy đủ cả 4 đáp án A, B, C, D hoặc bị cắt dở ở mép ảnh thì bắt buộc đặt `complete: false` và `answer: null`, tuyệt đối không đoán. " +
  "Dùng đúng số câu in trên trang; nếu trang không có số câu, đánh số từ trên xuống dưới bắt đầu từ 1 theo thứ tự xuất hiện. " +
  "Với câu đầy đủ, `answer` là đúng một chữ cái trong A, B, C, D. " +
  'Chỉ trả về JSON đúng schema `{"questions":[{"number":1,"complete":true,"answer":"A"},{"number":2,"complete":false,"answer":null}]}`, không thêm bất kỳ chữ hay ký tự nào khác.';

const FAST_MODE_SUFFIX =
  "Chỉ trả JSON hợp lệ, không giải thích.";

const ACCURATE_MODE_SUFFIX =
  "Hãy kiểm tra kỹ từng câu, đọc lại đề và loại trừ đáp án sai trước khi chốt, nhưng đầu ra cuối cùng vẫn chỉ xuất ra JSON theo đúng schema.";

const FIXED_USER_INSTRUCTION =
  "Giải các câu hỏi trắc nghiệm hiển thị đầy đủ (có trọn vẹn đề và đủ 4 đáp án A, B, C, D). " +
  "Đặt complete: false và answer: null cho bất kỳ câu nào bị khuất hoặc thiếu đáp án. Chỉ trả JSON.";

export function buildPrompts({ mode = "fast", customPrompt = "", domText = "" } = {}) {
  const modeInstruction = mode === "accurate" ? ACCURATE_MODE_SUFFIX : FAST_MODE_SUFFIX;
  const extra = typeof customPrompt === "string" && customPrompt.trim()
    ? `\nLưu ý bổ sung từ người dùng: ${customPrompt.trim()}`
    : "";

  // Prefix cố định nằm ở đầu, không chứa timestamp hay ID ngẫu nhiên để tận dụng Prompt Caching
  const systemPrompt = `${BASE_SYSTEM_PROMPT} ${modeInstruction}${extra}`;

  let userPrompt = FIXED_USER_INSTRUCTION;

  if (typeof domText === "string" && domText.trim()) {
    // Đặt phần hướng dẫn cố định ở đầu và phần văn bản DOM thay đổi ở cuối
    userPrompt =
      `${FIXED_USER_INSTRUCTION}\n\n` +
      "Nội dung câu hỏi trong vùng nhìn thấy (viewport):\n" +
      domText.trim();
  }

  return { systemPrompt, userPrompt };
}
