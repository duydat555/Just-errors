# just-errors

Tiện ích mở rộng Chrome (Manifest V3) cá nhân giúp chụp vùng màn hình đang nhìn thấy bằng phím tắt **Alt + Q**, gửi tới mô hình AI do bạn chọn để giải các câu hỏi trắc nghiệm A/B/C/D hiển thị đầy đủ, và hiện kết quả tối giản dạng `1A·2D·3B` ở góc dưới bên trái màn hình.

---

## 1. Tính năng chính
- **Phím tắt `Alt + Q`**: chụp vùng nhìn thấy của tab hiện tại, giải câu trắc nghiệm và hiện đáp án dạng `1A·2D·3B` (phân cách bằng dấu chấm giữa `·`, U+00B7).
- **Bảo vệ 2 lớp chỉ giải câu hiển thị ĐẦY ĐỦ**:
  1. **Lớp 1 (Prompt & Schema JSON)**: bắt buộc AI đánh dấu `complete: true` chỉ khi thấy trọn vẹn đề và đủ cả 4 đáp án A, B, C, D; câu bị cắt ở mép trên/dưới hoặc chưa cuộn tới đủ đáp án phải trả `complete: false, answer: null`.
  2. **Lớp 2 (`lib/parse.js`)**: tự động lọc bỏ mọi câu có `complete !== true` hoặc `answer` ngoài `{A, B, C, D}`, khử trùng lặp số câu và sắp xếp tăng dần.
- **Bong bóng kết quả cô lập bằng Shadow DOM**:
  - Chữ trắng đậm trên nền đen `#000` ở góc dưới bên trái (`left: 16px; bottom: 16px`).
  - Bấm bất kỳ đâu **ngoài bong bóng** hoặc nhấn `Esc` → bong bóng đóng ngay lập tức (nếu đang chờ AI thì hủy luôn request).
  - Bấm **vào trong bong bóng** → sao chép chuỗi đáp án vào clipboard, không đóng bong bóng.
  - Tự động xóa bong bóng cũ và chờ 2 khung hình (`requestAnimationFrame` x2) trước khi chụp ảnh ở lần bấm tiếp theo.
- **2 chế độ hoạt động**:
  - **Nhanh**: thu nhỏ cạnh dài ảnh tối đa `1280px` (JPEG `0.7`), dùng model tốc độ cao, tắt/giảm suy luận để phản hồi nhanh.
  - **Chính xác**: giữ cạnh dài ảnh tối đa `2560px` (JPEG `0.92`), dùng model mạnh nhất kèm chế độ suy luận (Thinking / Reasoning), có tùy chọn chạy 2 lần lấy đa số.
- **4 nhà cung cấp AI**: Anthropic (Claude), OpenAI (ChatGPT), Google Gemini, DeepSeek.
- **Trích xuất văn bản DOM (tùy chọn)**: ưu tiên đọc các khối câu hỏi nằm trọn trong viewport (`top >= 0 && bottom <= innerHeight`), tự động dự phòng bằng ảnh chụp màn hình nếu không tìm thấy.

---

## 2. Cài đặt (Load unpacked)
Dự án viết bằng JavaScript ES Module thuần, **không dùng bundler, không cần bước build**.

1. Mở trình duyệt Chrome (hoặc Edge / Brave), truy cập địa chỉ:
   ```text
   chrome://extensions
   ```
2. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Bấm nút **Load unpacked** (Tải tiện ích đã giải nén) ở góc trên bên trái.
4. Chọn thư mục `just-errors` (thư mục chứa file `manifest.json`).
5. Ghim biểu tượng **just-errors** lên thanh công cụ để tiện chuyển chế độ.

---

## 3. Lấy và nhập API Key
1. Bấm vào biểu tượng **just-errors** trên thanh công cụ → bấm nút **Options** (hoặc chuột phải vào biểu tượng → **Tùy chọn**).
2. Lấy API key từ nhà cung cấp bạn muốn sử dụng:
   - **Anthropic (Claude)**: [https://platform.claude.com/settings/keys](https://platform.claude.com/settings/keys)
   - **OpenAI (ChatGPT)**: [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   - **Google Gemini**: [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
   - **DeepSeek**: [https://platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
3. Dán API key vào ô tương ứng trong trang **Options**, bấm **Kiểm tra key** để xác nhận kết nối, sau đó bấm **Lưu cấu hình**.
4. **Bảo mật**: API key chỉ lưu cục bộ trong `chrome.storage.local` trên trình duyệt của bạn. Tiện ích chỉ gửi dữ liệu trực tiếp tới domain API chính thức của hãng bạn chọn, tuyệt đối không log key hay ảnh chụp ra console.

---

## 4. Đổi tên Model
Tên model không bị khóa cứng. Bạn có thể sửa trực tiếp ở 2 nơi:
1. **Trên giao diện Options (khuyên dùng)**:
   - Mở trang **Options** → tại mục của từng nhà cung cấp, sửa 2 ô **Model chế độ Nhanh (`fastModel`)** và **Model chế độ Chính xác (`accurateModel`)** → bấm **Lưu cấu hình**.
   - Có nút **Khôi phục tên model mặc định** nếu muốn quay về cấu hình gốc.
2. **Trong mã nguồn**:
   - Sửa đối tượng `PROVIDER_META` trong file `lib/settings.js`.

### Giá trị model mặc định hiện hành
| Nhà cung cấp | `fastModel` (Nhanh) | `accurateModel` (Chính xác) | `fallbackModel` (Dự phòng khi 503) | Ghi chú |
|---|---|---|---|---|
| **Anthropic** | `claude-haiku-5-5` | `claude-opus-5-5` | `claude-haiku-5-5` | Có thể đổi sang `claude-sonnet-5-5` hoặc `claude-fable-5-1` |
| **OpenAI** | `gpt-6-luna` | `gpt-6-astra` | `gpt-6-luna` | Có thể đổi sang `gpt-6.1-terra` hoặc `gpt-6.1-sol` |
| **Google Gemini** | `gemini-3.8-flash` | `gemini-4-argon` | `gemini-3.6-flash` | Khi `gemini-3.8-flash` hoặc `gemini-4-argon` bị quá tải (`503`) hoặc chạm hạn mức (`429`), tự động dự phòng sang `gemini-3.6-flash` (để trống nếu muốn tắt) |
| **DeepSeek** | `deepseek-flash` | `deepseek-flash` | `deepseek-flash` | `deepseek-flash` hỗ trợ cả ảnh (Vision) và bật/tắt Thinking. Model `deepseek-v4-pro` chỉ nhận văn bản (chỉ dùng khi bật tùy chọn *Ưu tiên đọc văn bản trang DOM*) |

---

## 5. Tiết kiệm chi phí, hạn mức (Quota) & Xử lý lỗi 429 / 503
- **Cache màn hình SHA-256 (10 phút)**:
  - Mỗi lần chụp (hoặc trích xuất DOM), tiện ích băm SHA-256 nội dung gửi đi. Nếu bạn bấm `Alt + Q` lại trên cùng một màn hình (cùng tab, cùng chế độ, cùng model) trong vòng 10 phút, tiện ích trả ngay kết quả đã lưu trong `chrome.storage.session` (**0 request API, 0$**) kèm nhãn `(đã lưu)`.
  - Trên bong bóng kết quả có nút **Giải lại** để buộc gọi API mới khi bạn muốn kiểm tra lại.
  - Không bao giờ lưu cache khi kết quả lỗi hoặc không có câu hoàn chỉnh.
- **Chống bấm dồn**:
  - Nếu đang xử lý mà bạn bấm nhầm `Alt + Q` lần nữa trên **cùng một màn hình** (hash không đổi), tiện ích **không** hủy request đang chạy và **không** gửi lại request mới. Chỉ khi bạn đã cuộn trang (màn hình thay đổi) mới hủy request cũ để giải màn hình mới.
  - Có cooldown ngắn (`~2 giây`) giữa hai lần gọi API hợp lệ liên tiếp trên cùng máy.
- **Theo dõi chi tiêu cục bộ (Popup & Options)**:
  - Tự động đọc trường `usage` (token vào, token ra, token suy luận, token cache) từ phản hồi của AI, cộng dồn theo ngày vào `chrome.storage.local` (chỉ lưu con số thống kê, tuyệt đối không lưu ảnh hay nội dung câu hỏi).
  - Hiển thị trên **Popup**: số lần gọi hôm nay, số lần tiết kiệm nhờ cache, tổng token vào/ra, chi phí ước tính (mặc định `2$/1M token vào`, `10$/1M token ra` theo `gpt-6.1-sol`, có thể sửa trong Options) và cảnh báo vàng khi vượt ngưỡng đặt trước (mặc định `3$`).
- **Nhận diện hết credit (`insufficient_quota`) vs. giới hạn tốc độ (`rate_limit_exceeded`)**:
  - **`429 insufficient_quota` / `402` (Hết tiền/credit)**: báo ngay `"Hết credit <Provider>, nạp thêm hoặc đổi provider"`, **không retry** và **không gọi `fallbackModel` cùng hãng**.
  - **`429 rate_limit_exceeded` (Vượt tốc độ RPM/TPM)**: đọc `Retry-After` / `retryDelay` từ server; nếu `≤ 5 giây` mới chờ đúng thời gian đó và thử lại tối đa 1 lần, nếu lâu hơn sẽ chuyển sang `fallbackModel` và đặt **cooldown phía client**.
  - **`503 (Service Unavailable)`**: Máy chủ AI đang quá tải tạm thời; thử lại có backoff ngắn hoặc chuyển sang `fallbackModel`.
- **Nút "Kiểm tra key" và "Thử model" tách rời**:
  - **Kiểm tra key**: chỉ gọi `GET /models` (không tốn bất kỳ quota giải bài nào) và đối chiếu cả 3 ô `fastModel`, `accurateModel`, `fallbackModel` với danh sách của key.
  - **Thử model**: chỉ khi bạn bấm chủ động mới gửi 1 request văn bản nhỏ tới `fastModel` (và tự chặn nếu model vừa dính `429`).
- **Chế độ "Chính xác chạy 2 lần" (Mặc định tắt)**:
  - Chạy **tuần tự** Lần 1 → Lần 2 (chỉ chạy Lần 2 khi bạn bật VÀ Lần 1 thành công). **Cảnh báo: làm tăng gấp đôi chi phí**, không nên bật khi cần tiết kiệm credit hoặc dùng gói Free tier.
- **Khuyến nghị cho Google Gemini Free Tier**:
  - Gói **Free tier** trong Google AI Studio có hạn mức RPM/RPD rất thấp và không hỗ trợ `gemini-4-argon`. Nếu thường xuyên gặp `429`, bạn nên bật **Billing (Pay-as-you-go)** trong Google AI Studio hoặc đổi `accurateModel` sang `gemini-3.8-flash` / `gemini-3.6-flash`.

---

## 6. Đổi phím tắt
Phím tắt mặc định:
- **Giải câu hỏi trên màn hình**: `Alt + Q`
- **Đổi chế độ Nhanh / Chính xác**: `Alt + Shift + Q`

Để thay đổi phím tắt:
1. Sao chép địa chỉ sau (có nút sao chép nhanh trong trang Options) và dán vào thanh địa chỉ trình duyệt:
   ```text
   chrome://extensions/shortcuts
   ```
2. Tìm tiện ích **just-errors** và gán tổ hợp phím mới theo ý muốn.

---

## 6. Các giới hạn đã biết
- **Trang hệ thống bị trình duyệt khóa**: Chrome không cho phép bất kỳ tiện ích nào chạy script hoặc chụp màn hình trên các trang `chrome://`, `edge://`, `chrome-extension://`, trang **Chrome Web Store** hoặc trình đọc PDF nội bộ. Khi bấm `Alt + Q` trên các trang này, biểu tượng tiện ích sẽ hiện dấu `!` để báo hiệu.
- **Trùng phím tắt `Alt + Q`**: Trên một số hệ điều hành hoặc phần mềm gõ tiếng Việt / phần mềm quay màn hình, `Alt + Q` có thể bị chiếm dụng. Nếu bấm không thấy phản hồi, hãy đổi sang phím tắt khác tại `chrome://extensions/shortcuts`.
- **DeepSeek Vision**: Trên API chính thức của DeepSeek, `deepseek-flash` hỗ trợ đọc ảnh (Vision), còn `deepseek-v4-pro` chỉ hỗ trợ văn bản. Nếu muốn dùng `deepseek-v4-pro`, hãy bật tùy chọn *"Ưu tiên đọc văn bản trang (DOM trong viewport)"* trong Options.
