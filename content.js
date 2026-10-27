(() => {
  if (window.__justErrorsContentLoaded) {
    return;
  }
  window.__justErrorsContentLoaded = true;

  let hostEl = null;
  let bubbleEl = null;
  let metaEl = null;
  let currentState = null; // "loading" | "result" | "error" | null
  let currentText = "";
  let listenersAttached = false;

  /**
   * Đóng bong bóng khi người dùng bấm bất kỳ đâu bên ngoài bong bóng.
   */
  function onDocumentPointerDown(event) {
    if (!hostEl) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (
      path.includes(hostEl) ||
      (bubbleEl && path.includes(bubbleEl)) ||
      (metaEl && path.includes(metaEl))
    ) {
      return; // Bấm bên trong bong bóng -> không đóng
    }
    const wasLoading = currentState === "loading";
    removeBubble();
    if (wasLoading) {
      safelyNotifyCancel();
    }
  }

  /**
   * Đóng bong bóng khi bấm phím Escape.
   */
  function onDocumentKeyDown(event) {
    if (!hostEl) return;
    if (event.key === "Escape") {
      const wasLoading = currentState === "loading";
      removeBubble();
      if (wasLoading) {
        safelyNotifyCancel();
      }
    }
  }

  function safelyNotifyCancel() {
    try {
      chrome.runtime.sendMessage({ type: "CANCEL" }).catch(() => {});
    } catch (_) {}
  }

  function safelyRequestForceResolve() {
    try {
      chrome.runtime.sendMessage({ type: "FORCE_RESOLVE" }).catch(() => {});
    } catch (_) {}
  }

  function attachGlobalListeners() {
    if (listenersAttached) return;
    document.addEventListener("pointerdown", onDocumentPointerDown, { capture: true, passive: true });
    document.addEventListener("keydown", onDocumentKeyDown, { capture: true, passive: true });
    listenersAttached = true;
  }

  function detachGlobalListeners() {
    if (!listenersAttached) return;
    document.removeEventListener("pointerdown", onDocumentPointerDown, { capture: true });
    document.removeEventListener("keydown", onDocumentKeyDown, { capture: true });
    listenersAttached = false;
  }

  function removeBubble() {
    detachGlobalListeners();
    if (hostEl && hostEl.parentNode) {
      hostEl.parentNode.removeChild(hostEl);
    }
    hostEl = null;
    bubbleEl = null;
    metaEl = null;
    currentState = null;
    currentText = "";
  }

  /**
   * Tạo mới hoặc cập nhật bong bóng duy nhất ở góc dưới bên trái.
   */
  function showBubble(text, state, { metaText = "", showReSolve = false } = {}) {
    if (!hostEl || !hostEl.isConnected) {
      removeBubble();

      hostEl = document.createElement("div");
      hostEl.setAttribute("data-just-errors", "1");
      hostEl.style.cssText = [
        "all: initial",
        "position: fixed",
        "left: 16px",
        "bottom: 16px",
        "z-index: 2147483647",
        "pointer-events: none",
        "margin: 0",
        "padding: 0",
        "border: 0"
      ].join(" !important; ") + " !important;";

      const shadow = hostEl.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host {
          all: initial;
        }
        .je-bubble {
          box-sizing: border-box;
          display: inline-block;
          max-width: min(88vw, 560px);
          background: #000000;
          color: #ffffff;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-size: 16px;
          font-weight: 700;
          line-height: 1.35;
          letter-spacing: 0.02em;
          padding: 8px 12px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
          pointer-events: auto;
          user-select: none;
          cursor: pointer;
          word-break: break-word;
          white-space: pre-wrap;
        }
        .je-meta {
          box-sizing: border-box;
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 3px;
          padding: 2px 7px;
          width: fit-content;
          max-width: min(88vw, 560px);
          background: rgba(0, 0, 0, 0.88);
          color: #a1a1aa;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 10px;
          font-weight: 500;
          line-height: 1.25;
          border-radius: 5px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          pointer-events: auto;
          user-select: none;
        }
        .je-meta:empty {
          display: none;
        }
        .je-resolve-btn {
          background: #1f1f24;
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.25);
          border-radius: 4px;
          padding: 1px 5px;
          font-family: inherit;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
        }
        .je-resolve-btn:hover {
          background: #32323a;
        }
      `;

      bubbleEl = document.createElement("div");
      bubbleEl.className = "je-bubble";
      bubbleEl.title = "Bấm để sao chép";
      bubbleEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentText && currentState !== "loading") {
          navigator.clipboard?.writeText(currentText).catch(() => {});
        }
      });

      metaEl = document.createElement("div");
      metaEl.className = "je-meta";

      shadow.appendChild(style);
      shadow.appendChild(bubbleEl);
      shadow.appendChild(metaEl);
      (document.documentElement || document.body).appendChild(hostEl);
      attachGlobalListeners();
    }

    currentState = state;
    currentText = text;
    bubbleEl.textContent = text;

    if (metaEl) {
      metaEl.textContent = "";
      if (metaText) {
        const span = document.createElement("span");
        span.textContent = metaText;
        metaEl.appendChild(span);
      }
      if (showReSolve) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "je-resolve-btn";
        btn.textContent = "Giải lại";
        btn.title = "Gọi API giải lại màn hình này (bỏ qua cache)";
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          safelyRequestForceResolve();
        });
        metaEl.appendChild(btn);
      }
    }
  }

  function waitTwoFrames() {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timer = setTimeout(done, 80);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          clearTimeout(timer);
          done();
        });
      });
    });
  }

  function looksLikeSingleQuestionBlock(el) {
    if (!el || el === hostEl) return false;
    const text = (el.innerText || el.textContent || "").trim();
    if (text.length < 15 || text.length > 4000) return false;

    const hasExplicitABCD =
      /(?:^|\n|\s)A[.):\s]/m.test(text) &&
      /(?:^|\n|\s)B[.):\s]/m.test(text) &&
      /(?:^|\n|\s)C[.):\s]/m.test(text) &&
      /(?:^|\n|\s)D[.):\s]/m.test(text);

    const countA = (text.match(/(?:^|\n)\s*A[.):\s]/gm) || []).length;
    if (countA > 1) return false;

    let inputsCount = 0;
    if (typeof el.querySelectorAll === "function") {
      inputsCount = el.querySelectorAll(
        'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
      ).length;
    }

    if (inputsCount > 6) return false;
    return hasExplicitABCD || inputsCount === 4;
  }

  function extractVisibleQuestionsFromDom() {
    if (!document.body || typeof document.body.querySelectorAll !== "function") {
      return { ok: true, text: "", count: 0 };
    }

    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    if (vh <= 0 || vw <= 0) {
      return { ok: true, text: "", count: 0 };
    }

    const candidates = Array.from(
      document.body.querySelectorAll("article, section, fieldset, li, div, form")
    ).filter(looksLikeSingleQuestionBlock);

    const leafBlocks = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other))
    );

    const visibleBlocks = [];
    for (const el of leafBlocks) {
      if (typeof el.getBoundingClientRect !== "function") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      if (rect.top >= 0 && rect.bottom <= vh) {
        const rawText = (el.innerText || el.textContent || "")
          .replace(/\r\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        if (rawText) {
          visibleBlocks.push({
            top: rect.top,
            text: rawText
          });
        }
      }
    }

    visibleBlocks.sort((a, b) => a.top - b.top);

    if (visibleBlocks.length === 0) {
      return { ok: true, text: "", count: 0 };
    }

    const combined = visibleBlocks
      .map((item, idx) => `--- Khối câu hỏi ${idx + 1} ---\n${item.text}`)
      .join("\n\n");

    return {
      ok: true,
      text: combined,
      count: visibleBlocks.length
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }

    switch (message.type) {
      case "PING": {
        sendResponse({ ok: true });
        return false;
      }

      case "HIDE": {
        removeBubble();
        waitTwoFrames().then(() => {
          sendResponse({ hidden: true });
        });
        return true;
      }

      case "EXTRACT_DOM": {
        const result = extractVisibleQuestionsFromDom();
        sendResponse(result);
        return false;
      }

      case "LOADING": {
        showBubble("…", "loading");
        sendResponse({ ok: true });
        return false;
      }

      case "RESULT": {
        const text =
          typeof message.text === "string" && message.text.trim()
            ? message.text.trim()
            : "Không thấy câu hoàn chỉnh";
        let metaLabel = "";
        if (message.fromCache) {
          const pLabel = message.providerName ? `${message.providerName} · ` : "";
          const mLabel = message.model ? `${message.model} ` : "";
          metaLabel = `${pLabel}${mLabel}(đã lưu)`.trim();
        } else if (message.model) {
          const pLabel = message.providerName ? `${message.providerName} · ` : "";
          const fbNote = message.usedCrossProvider
            ? " (dự phòng chéo)"
            : message.usedFallback
              ? " (dự phòng)"
              : "";
          const reqNote =
            typeof message.totalRequests === "number" && message.totalRequests > 0
              ? ` · ${message.totalRequests} req`
              : "";
          metaLabel = `${pLabel}${message.model}${fbNote}${reqNote}`;
        }
        showBubble(text, "result", {
          metaText: metaLabel,
          showReSolve: Boolean(message.fromCache || message.model)
        });
        if (bubbleEl) {
          bubbleEl.title = metaLabel
            ? `${metaLabel} — Bấm để sao chép`
            : "Bấm để sao chép";
        }
        sendResponse({ ok: true });
        return false;
      }

      case "ERROR": {
        const reason =
          typeof message.text === "string" && message.text.trim()
            ? message.text.trim()
            : "Đã xảy ra lỗi";
        const display = reason.startsWith("!") ? reason : `! ${reason}`;
        showBubble(display, "error", {
          metaText: "",
          showReSolve: Boolean(message.canRetry)
        });
        sendResponse({ ok: true });
        return false;
      }

      default:
        return false;
    }
  });
})();
