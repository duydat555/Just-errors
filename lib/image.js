export const IMAGE_PRESETS = {
  fast: {
    maxLongEdge: 1280,
    mimeType: "image/jpeg",
    quality: 0.7
  },
  accurate: {
    maxLongEdge: 2560,
    mimeType: "image/jpeg",
    quality: 0.92
  }
};

/**
 * Tính toán kích thước đích (width, height) dựa trên kích thước thực của ảnh
 * (đã tính sẵn devicePixelRatio từ captureVisibleTab) sao cho cạnh dài không vượt maxLongEdge.
 */
export function computeTargetDimensions(width, height, maxLongEdge) {
  if (!width || !height || width <= 0 || height <= 0) {
    return { width: 1, height: 1, scaled: false };
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return { width: Math.round(width), height: Math.round(height), scaled: false };
  }
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true
  };
}

/**
 * Ước lượng số token hình ảnh theo công thức tile chuẩn của OpenAI (85 + 170 * số ô 512x512).
 */
export function estimateImageTokens(width, height, mode = "accurate") {
  if (!width || !height || width <= 0 || height <= 0) return 0;
  if (mode === "fast") {
    return 85; // detail: "low" trên OpenAI tốn cố định ~85 token
  }
  // detail: "high": scale về khung tối đa 2048x2048, cạnh ngắn về 768px, rồi chia ô 512x512
  let w = width;
  let h = height;
  if (w > 2048 || h > 2048) {
    const s = 2048 / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const shortEdge = Math.min(w, h);
  if (shortEdge > 768) {
    const s = 768 / shortEdge;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const tilesX = Math.ceil(w / 512);
  const tilesY = Math.ceil(h / 512);
  return 85 + 170 * tilesX * tilesY;
}

/**
 * Phát hiện an toàn dải lề trái/phải đồng màu tuyệt đối (100% trống) trên màn hình rộng.
 * - TUYỆT ĐỐI KHÔNG cắt mép trên hay mép dưới (để giữ nguyên việc phát hiện câu hỏi bị cắt ở mép trên/dưới).
 * - Chỉ cắt lề trái/phải khi toàn bộ cột điểm ảnh đồng màu tuyệt đối (sai khác = 0) và lề đủ rộng (> 12% chiều ngang).
 * - Nếu có bất kỳ nghi ngờ nào hoặc chiều rộng còn lại < 50% ảnh gốc thì giữ nguyên 100% ảnh gốc.
 */
export function detectSafeHorizontalCrop(rgbaData, width, height) {
  if (!rgbaData || width < 400 || height < 100 || rgbaData.length < width * height * 4) {
    return { cropX: 0, cropWidth: width, cropped: false };
  }

  const isUniformColumn = (x, refR, refG, refB) => {
    const stepY = Math.max(1, Math.floor(height / 80));
    for (let y = 0; y < height; y += stepY) {
      const idx = (y * width + x) * 4;
      if (
        rgbaData[idx] !== refR ||
        rgbaData[idx + 1] !== refG ||
        rgbaData[idx + 2] !== refB
      ) {
        return false;
      }
    }
    return true;
  };

  // Kiểm tra lề trái dựa theo màu góc trái trên (0, 0)
  const leftR = rgbaData[0];
  const leftG = rgbaData[1];
  const leftB = rgbaData[2];
  let leftTrim = 0;
  const maxTrimEachSide = Math.floor(width * 0.3);

  while (leftTrim < maxTrimEachSide && isUniformColumn(leftTrim, leftR, leftG, leftB)) {
    leftTrim++;
  }

  // Kiểm tra lề phải dựa theo màu góc phải trên (width - 1, 0)
  const rightIdx = (width - 1) * 4;
  const rightR = rgbaData[rightIdx];
  const rightG = rgbaData[rightIdx + 1];
  const rightB = rgbaData[rightIdx + 2];
  let rightTrim = 0;

  while (
    rightTrim < maxTrimEachSide &&
    isUniformColumn(width - 1 - rightTrim, rightR, rightG, rightB)
  ) {
    rightTrim++;
  }

  // Chừa lại khoảng đệm an toàn 24px mỗi bên
  const safeLeft = Math.max(0, leftTrim - 24);
  const safeRight = Math.max(0, rightTrim - 24);
  const totalSaved = safeLeft + safeRight;

  // Chỉ cắt khi tiết kiệm được tối thiểu 12% chiều ngang
  if (totalSaved < Math.floor(width * 0.12)) {
    return { cropX: 0, cropWidth: width, cropped: false };
  }

  const cropWidth = width - totalSaved;
  if (cropWidth < Math.floor(width * 0.5)) {
    return { cropX: 0, cropWidth: width, cropped: false };
  }

  return {
    cropX: safeLeft,
    cropWidth,
    cropped: true
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

/**
 * Tính mã băm SHA-256 (hex) của chuỗi đầu vào (ảnh base64 đã resize hoặc văn bản DOM)
 * để phát hiện màn hình trùng lặp mà không cần lưu nội dung ảnh/câu hỏi.
 */
export async function computeContentHash(input) {
  const str = typeof input === "string" ? input : String(input || "");
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    try {
      const encoded = new TextEncoder().encode(str);
      const digest = await crypto.subtle.digest("SHA-256", encoded);
      const bytes = new Uint8Array(digest);
      let hex = "";
      for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
      }
      return hex;
    } catch (_) {}
  }

  // Fallback băm 64-bit kết hợp nếu môi trường thiếu crypto.subtle
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Resize và nén ảnh chụp màn hình theo chế độ ("fast" hoặc "accurate"):
 * - Giữ nguyên độ phân giải và chất lượng của chế độ Chính xác (2560px, JPEG 0.92).
 * - Chỉ cắt bỏ dải lề trái/phải nếu phát hiện chắc chắn 100% trống đồng màu.
 */
export async function processScreenshot(imageDataUrl, mode = "fast") {
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:")) {
    return imageDataUrl;
  }

  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    return imageDataUrl;
  }

  const preset = mode === "accurate" ? IMAGE_PRESETS.accurate : IMAGE_PRESETS.fast;

  let bitmap = null;
  try {
    const res = await fetch(imageDataUrl);
    const srcBlob = await res.blob();
    bitmap = await createImageBitmap(srcBlob);

    let srcX = 0;
    let srcW = bitmap.width;
    const srcH = bitmap.height;

    // Kiểm tra an toàn lề trống trái/phải nếu trình duyệt hỗ trợ getImageData trên OffscreenCanvas
    try {
      const probeCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
      if (probeCtx && typeof probeCtx.getImageData === "function") {
        probeCtx.drawImage(bitmap, 0, 0);
        const imgData = probeCtx.getImageData(0, 0, bitmap.width, bitmap.height);
        if (imgData && imgData.data) {
          const crop = detectSafeHorizontalCrop(
            imgData.data,
            bitmap.width,
            bitmap.height
          );
          if (crop.cropped) {
            srcX = crop.cropX;
            srcW = crop.cropWidth;
          }
        }
      }
    } catch (_) {
      // Nếu không đọc được pixel thì giữ nguyên 100% khung ảnh gốc
      srcX = 0;
      srcW = bitmap.width;
    }

    const { width, height } = computeTargetDimensions(
      srcW,
      srcH,
      preset.maxLongEdge
    );

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      return imageDataUrl;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (srcX > 0 || srcW !== bitmap.width) {
      ctx.drawImage(bitmap, srcX, 0, srcW, srcH, 0, 0, width, height);
    } else {
      ctx.drawImage(bitmap, 0, 0, width, height);
    }

    const outBlob = await canvas.convertToBlob({
      type: preset.mimeType,
      quality: preset.quality
    });
    const arrayBuffer = await outBlob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    return `data:${preset.mimeType};base64,${base64}`;
  } catch (_) {
    return imageDataUrl;
  } finally {
    if (bitmap && typeof bitmap.close === "function") {
      try {
        bitmap.close();
      } catch (_) {}
    }
  }
}
