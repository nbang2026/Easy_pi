export type ConversationState = {
  busy?: boolean;
  ready?: boolean;
  connected?: boolean;
};

export type ConversationEvent = {
  type?: string;
  role?: "user" | "assistant" | "system" | string;
  text?: string;
  messageId?: string;
  append?: boolean;
  truncated?: boolean;
  sessionId?: string;
};

export type ConversationViewOptions = {
  root: HTMLElement;
  onContinue?: () => void;
  onRegenerate?: () => void;
  nextStepEnabled?: () => boolean;
  outlineEnabled?: () => boolean;
  onNextStep?: () => void;
  onOutline?: () => void;
  onNotice?: (message: string) => void;
};

type AssistantTurn = {
  node: HTMLElement;
  answer: HTMLElement;
  status: HTMLElement;
  conclusion: HTMLDetailsElement;
  conclusionText: HTMLElement;
};

const cleanText = (value: unknown) => typeof value === "string" ? value.replace(/\u0000/g, "") : "";

function extractConclusion(text: string): string {
  return /^[\t ]*(?:结论|结论是|先说结论|summary|conclusion)[\t ]*[:：][\t ]*([^\r\n]*)/im.exec(text)?.[1].trim() || "";
}

async function copyText(text: string): Promise<void> {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function handleMenuKeyboard(
  event: KeyboardEvent,
  menu: HTMLElement,
  trigger: HTMLElement,
  close: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    trigger.focus();
    return;
  }
  if (event.key === "Tab") {
    setTimeout(close, 0);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    .filter((item) => !item.hidden);
  if (!items.length) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
  event.preventDefault();
  items[nextIndex]?.focus();
}

export function setupConversationView(options: ConversationViewOptions) {
  const root = options.root;
  const scroll = root.querySelector<HTMLElement>("#conversation-scroll")!;
  const empty = root.querySelector<HTMLElement>("#conversation-empty")!;
  const messages = root.querySelector<HTMLElement>("#conversation-messages")!;
  const actions = root.querySelector<HTMLElement>(".conversation-actions")!;
  const quickActions = root.querySelector<HTMLElement>("#conversation-quick-actions")!;
  const quickActionsToggle = root.querySelector<HTMLButtonElement>("#conversation-quick-actions-toggle")!;
  const staticAssistant = root.querySelector<HTMLElement>("#conversation-assistant")!;
  let current: AssistantTurn | undefined;
  let staticUsed = false;
  let disposed = false;
  let lastAnswer = "";
  let busy = false;
  let connected = true;
  let startedAt = 0;
  const assistantMessages = new Map<string, AssistantTurn>();
  const userMessages = new Set<string>();
  const truncationNotices = new Set<string>();
  const optimisticUsers: { node: HTMLElement; text: string }[] = [];
  const listeners = new AbortController();
  const savedIcon = "/app-icon.png";
  let activeAssistantIcon = savedIcon;
  const savedPosition = (() => {
    try {
      const value = JSON.parse(localStorage.getItem("pi.quickActionsPosition") || "null");
      return value && Number.isFinite(value.right) && Number.isFinite(value.bottom) ? value : null;
    } catch { return null; }
  })();
  const applyIcon = (src: string) => {
    activeAssistantIcon = src;
    root.querySelectorAll<HTMLImageElement>(".conversation-avatar img, #conversation-empty img").forEach(image => { image.src = src; });
    const image = document.createElement("img");
    image.src = src; image.alt = ""; image.draggable = false;
    quickActionsToggle.replaceChildren(image);
  };
  applyIcon(savedIcon);
  if (savedPosition) {
    quickActions.style.right = `${savedPosition.right}px`;
    quickActions.style.bottom = `${savedPosition.bottom}px`;
  }
  let positionQuickMenu = () => {};
  const constrainQuickActions = () => {
    if (quickActions.hidden) return;
    const bounds = root.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const rect = quickActionsToggle.getBoundingClientRect();
    const right = Math.max(8, Math.min(Math.max(8, root.clientWidth - rect.width - 8), Number.parseFloat(quickActions.style.right) || bounds.right - rect.right));
    const bottom = Math.max(8, Math.min(Math.max(8, root.clientHeight - rect.height - 8), Number.parseFloat(quickActions.style.bottom) || bounds.bottom - rect.bottom));
    quickActions.style.right = `${right}px`;
    quickActions.style.bottom = `${bottom}px`;
    positionQuickMenu();
  };
  const viewWindow = root.ownerDocument.defaultView;
  viewWindow?.addEventListener("resize", constrainQuickActions);
  const resizeObserver = viewWindow?.ResizeObserver ? new viewWindow.ResizeObserver(constrainQuickActions) : undefined;
  resizeObserver?.observe(root);

  const notice = (message: string) => options.onNotice?.(message);
  let syncQuickActions = () => {};
  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const follow = () => {
    if (atBottom()) scroll.scrollTop = scroll.scrollHeight;
  };
  const getAnswer = () => {
    if (current?.answer.textContent?.trim()) return current.answer.textContent.trim();
    return lastAnswer;
  };
  const updateEmpty = () => {
    const hasMessages = messages.children.length > 0;
    empty.hidden = hasMessages;
    actions.hidden = !hasMessages || !getAnswer();
    syncQuickActions();
  };
  const createAssistant = (): AssistantTurn => {
    const node = document.createElement("article");
    node.className = "conversation-assistant";
    const author = document.createElement("header");
    author.className = "conversation-author";
    const avatar = document.createElement("span");
    avatar.className = "conversation-avatar";
    const image = document.createElement("img");
    image.src = activeAssistantIcon;
    image.alt = "";
    avatar.append(image);
    const name = document.createElement("strong");
    name.textContent = "easy_pi";
    const status = document.createElement("span");
    status.className = "conversation-status";
    status.textContent = "已就绪";
    author.append(avatar, name, status);
    const answer = document.createElement("div");
    answer.className = "conversation-answer";
    const conclusion = document.createElement("details");
    conclusion.className = "conversation-conclusion";
    conclusion.hidden = true;
    const summary = document.createElement("summary");
    summary.textContent = "先说结论";
    const conclusionText = document.createElement("div");
    conclusionText.className = "conversation-conclusion-text";
    conclusion.append(summary, conclusionText);
    node.append(author, answer, conclusion);
    messages.append(node);
    updateEmpty();
    return { node, answer, status, conclusion, conclusionText };
  };
  const ensureAssistant = () => {
    if (current?.node.isConnected) return current;
    if (!staticUsed) {
      messages.append(staticAssistant);
      staticUsed = true;
      const status = staticAssistant.querySelector<HTMLElement>("#conversation-status")!;
      const answer = staticAssistant.querySelector<HTMLElement>("#conversation-answer")!;
      const conclusion = staticAssistant.querySelector<HTMLDetailsElement>("#conversation-conclusion")!;
      const conclusionText = staticAssistant.querySelector<HTMLElement>("#conversation-conclusion-text")!;
      staticAssistant.hidden = false;
      current = { node: staticAssistant, answer, status, conclusion, conclusionText };
      updateEmpty();
      return current;
    }
    current = createAssistant();
    return current;
  };
  const setStatus = (value: string) => {
    if (current) current.status.textContent = value;
  };
  const elapsed = () => {
    if (!startedAt) return "";
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  };
  const completedStatus = () => `已完成 ${elapsed() || "刚刚"} >`;
  const addUserMessage = (text: string, attachments: string[] = [], messageId?: string) => {
    if (disposed || !text.trim()) return;
    if (messageId) {
      if (userMessages.has(messageId)) return;
      userMessages.add(messageId);
      const optimistic = optimisticUsers.findIndex(item => item.text === text);
      if (optimistic >= 0) { optimisticUsers.splice(optimistic, 1); return; }
    }
    const node = document.createElement("article");
    node.className = "conversation-user";
    const label = document.createElement("div");
    label.className = "conversation-user-label";
    label.textContent = "你";
    const body = document.createElement("div");
    body.className = "conversation-user-text";
    body.textContent = text;
    node.append(label, body);
    if (attachments.length) {
      const list = document.createElement("div");
      list.className = "conversation-user-attachments";
      list.textContent = attachments.map((path) => path.split(/[\\/]/).pop() || path).join(" · ");
      node.append(list);
    }
    messages.append(node);
    if (!messageId) optimisticUsers.push({ node, text });
    current = undefined;
    // A new user turn invalidates the previous answer for copy/export/read
    // actions until the new assistant turn produces content.
    lastAnswer = "";
    updateEmpty();
    scroll.scrollTop = scroll.scrollHeight;
  };
  const appendAssistant = (text: string, append = true, messageId?: string) => {
    if (disposed || !text) return;
    const shouldFollow = atBottom();
    if (messageId && assistantMessages.has(messageId)) current = assistantMessages.get(messageId);
    else if (messageId) {
      if (current?.answer.textContent) current = undefined;
    }
    const turn = ensureAssistant();
    if (messageId) assistantMessages.set(messageId, turn);
    turn.node.hidden = false;
    const node = turn.answer.firstChild;
    if (append && node?.nodeType === 3) (node as Text).appendData(text);
    else if (append) turn.answer.append(document.createTextNode(text));
    else turn.answer.textContent = text;
    lastAnswer = turn.answer.textContent;
    const conclusion = extractConclusion(lastAnswer);
    turn.conclusion.hidden = !conclusion;
    turn.conclusionText.textContent = conclusion;
    turn.status.textContent = busy ? "正在处理…" : completedStatus();
    updateEmpty();
    if (turn.answer.nextSibling !== actions) turn.answer.after(actions);
    if (shouldFollow) scroll.scrollTop = scroll.scrollHeight;
  };
  const clear = () => {
    messages.replaceChildren();
    current = undefined;
    staticUsed = false;
    lastAnswer = "";
    busy = false;
    startedAt = 0;
    assistantMessages.clear();
    userMessages.clear();
    truncationNotices.clear();
    optimisticUsers.length = 0;
    root.querySelectorAll('[aria-pressed="true"]').forEach(node => node.setAttribute("aria-pressed", "false"));
    root.querySelectorAll('[aria-checked="true"]').forEach(node => node.setAttribute("aria-checked", "false"));
    const menu = root.querySelector<HTMLElement>("#conversation-more-menu");
    if (menu) menu.hidden = true;
    root.querySelector("#conversation-more")?.setAttribute("aria-expanded", "false");
    staticAssistant.hidden = true;
    const answer = staticAssistant.querySelector<HTMLElement>("#conversation-answer");
    const status = staticAssistant.querySelector<HTMLElement>("#conversation-status");
    const conclusion = staticAssistant.querySelector<HTMLDetailsElement>("#conversation-conclusion");
    const conclusionText = staticAssistant.querySelector<HTMLElement>("#conversation-conclusion-text");
    if (answer) answer.textContent = "";
    if (status) status.textContent = "已就绪";
    if (conclusion) conclusion.hidden = true;
    if (conclusionText) conclusionText.textContent = "";
    updateEmpty();
  };
  const setState = (state: ConversationState) => {
    if (disposed) return;
    if (state.connected !== undefined) connected = state.connected;
    if (state.busy) {
      if (!busy) startedAt = Date.now();
      busy = true;
      const hasPendingUser = messages.lastElementChild?.classList.contains("conversation-user");
      if (current || hasPendingUser) {
        const turn = ensureAssistant();
        turn.node.hidden = false;
        turn.status.textContent = "正在处理…";
        follow();
      }
    } else if (state.connected === false) {
      busy = false;
      if (current) current.status.textContent = "未连接";
    } else if (current && current.answer.textContent.trim()) {
      busy = false;
      current.status.textContent = completedStatus();
      startedAt = 0;
    } else if (state.ready) {
      busy = false;
      startedAt = 0;
      if (current) current.status.textContent = "已就绪";
    }
    syncQuickActions();
  };
  const currentOrLatest = () => getAnswer();
  const copy = () => {
    const text = currentOrLatest();
    if (!text) return notice("当前还没有可复制的回答。");
    void copyText(text).then(() => notice("已复制回答")).catch(() => notice("复制失败，请重试。"));
  };
  const speak = () => {
    const text = currentOrLatest();
    if (!text || !("speechSynthesis" in window)) return notice("当前环境不支持朗读。");
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };
  const copyButton = root.querySelector<HTMLButtonElement>("#conversation-copy")!;
  const speakButton = root.querySelector<HTMLButtonElement>("#conversation-speak")!;
  const moreButton = root.querySelector<HTMLButtonElement>("#conversation-more")!;
  const moreMenu = root.querySelector<HTMLElement>("#conversation-more-menu")!;
  const continueButton = root.querySelector<HTMLButtonElement>("#conversation-continue")!;
  const quickActionsMenu = root.querySelector<HTMLElement>("#conversation-quick-actions-menu")!;
  const quickCopyButton = root.querySelector<HTMLButtonElement>("#conversation-quick-copy")!;
  const quickContinueButton = root.querySelector<HTMLButtonElement>("#conversation-quick-continue")!;
  const quickRegenerateButton = root.querySelector<HTMLButtonElement>("#conversation-quick-regenerate")!;
  const quickResetPositionButton = root.querySelector<HTMLButtonElement>("#conversation-quick-reset-position")!;
  const nextStepButton = root.querySelector<HTMLButtonElement>("#conversation-next-step")!;
  const outlineButton = root.querySelector<HTMLButtonElement>("#conversation-outline")!;
  const closeQuickActions = () => {
    quickActionsMenu.hidden = true;
    quickActionsToggle.setAttribute("aria-expanded", "false");
  };
  syncQuickActions = () => {
    const hasAnswer = !!getAnswer().trim() && !busy;
    nextStepButton.hidden = !hasAnswer || !(options.nextStepEnabled?.() ?? false);
    outlineButton.hidden = !hasAnswer || !(options.outlineEnabled?.() ?? false);
    quickActions.hidden = !hasAnswer;
    const taskDisabled = !hasAnswer || !connected;
    for (const button of [continueButton, regenerateButton, quickContinueButton, quickRegenerateButton]) button.disabled = taskDisabled;
    nextStepButton.disabled = taskDisabled || nextStepButton.hidden;
    outlineButton.disabled = taskDisabled || outlineButton.hidden;
    clearButton.disabled = busy;
    if (quickActions.hidden) closeQuickActions();
    else constrainQuickActions();
  };
  const regenerateButton = root.querySelector<HTMLButtonElement>("#conversation-regenerate")!;
  const exportButton = root.querySelector<HTMLButtonElement>("#conversation-export")!;
  const clearButton = root.querySelector<HTMLButtonElement>("#conversation-clear")!;
  const runAnswerAction = (callback?: () => void) => {
    if (!disposed && !busy && connected && getAnswer().trim()) callback?.();
  };
  const on = (button: HTMLElement, handler: () => void) => button.addEventListener("click", handler, { signal: listeners.signal });
  const closeMenu = () => {
    moreMenu.hidden = true;
    moreButton.setAttribute("aria-expanded", "false");
  };
  moreMenu.addEventListener("keydown", (event) => handleMenuKeyboard(event, moreMenu, moreButton, closeMenu), { signal: listeners.signal });
  quickActionsMenu.addEventListener("keydown", (event) => handleMenuKeyboard(event, quickActionsMenu, quickActionsToggle, closeQuickActions), { signal: listeners.signal });
  on(copyButton, copy);
  on(speakButton, () => { closeMenu(); speak(); });
  on(moreButton, () => {
    moreMenu.hidden = !moreMenu.hidden;
    moreButton.setAttribute("aria-expanded", String(!moreMenu.hidden));
    if (!moreMenu.hidden) {
      moreMenu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    }
  });
  on(regenerateButton, () => {
    closeMenu();
    runAnswerAction(options.onRegenerate);
  });
  on(exportButton, () => {
    closeMenu();
    const text = currentOrLatest();
    if (!text) return notice("当前还没有可导出的回答。");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    anchor.download = `easy_pi-answer-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  });
  on(clearButton, () => { if (!busy) { closeMenu(); clear(); } });
  on(continueButton, () => runAnswerAction(options.onContinue));
  positionQuickMenu = () => {
    if (quickActionsMenu.hidden) return;
    const bounds = root.getBoundingClientRect();
    const button = quickActionsToggle.getBoundingClientRect();
    const above = Math.max(0, button.top - bounds.top - 16);
    const below = Math.max(0, bounds.top + bounds.height - button.bottom - 16);
    const opensBelow = above < 260 && below > above;
    quickActionsMenu.style.bottom = opensBelow ? "auto" : "42px";
    quickActionsMenu.style.top = opensBelow ? "42px" : "auto";
    if (bounds.height) quickActionsMenu.style.maxHeight = `${Math.min(260, opensBelow ? below : above)}px`;
    if (bounds.width) {
      quickActionsMenu.style.minWidth = `${Math.min(170, Math.max(0, bounds.width - 16))}px`;
      quickActionsMenu.style.maxWidth = `${Math.max(0, bounds.width - 16)}px`;
    }
    quickActionsMenu.style.right = "0";
    quickActionsMenu.style.left = "auto";
    if (quickActionsMenu.getBoundingClientRect().left < bounds.left) {
      quickActionsMenu.style.right = "auto";
      quickActionsMenu.style.left = "0";
    }
  };
  on(quickActionsToggle, () => {
    if (quickActions.hidden) return;
    quickActionsMenu.hidden = !quickActionsMenu.hidden;
    quickActionsToggle.setAttribute("aria-expanded", String(!quickActionsMenu.hidden));
    if (!quickActionsMenu.hidden) {
      positionQuickMenu();
      quickActionsMenu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled):not([hidden])')?.focus();
    }
  });
  on(quickCopyButton, () => { closeQuickActions(); copy(); });
  on(quickContinueButton, () => { closeQuickActions(); runAnswerAction(options.onContinue); });
  on(quickRegenerateButton, () => { closeQuickActions(); runAnswerAction(options.onRegenerate); });
  on(quickResetPositionButton, () => {
    quickActions.style.right = "22px";
    quickActions.style.bottom = "14px";
    constrainQuickActions();
    try { localStorage.removeItem("pi.quickActionsPosition"); } catch {}
    closeQuickActions();
  });
  let drag: { pointerId: number; x: number; y: number; right: number; bottom: number; moved: boolean } | undefined;
  quickActionsToggle.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    delete quickActionsToggle.dataset.dragged;
    const rect = quickActionsToggle.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, right: bounds.left + root.clientLeft + root.clientWidth - rect.right, bottom: bounds.top + root.clientTop + root.clientHeight - rect.bottom, moved: false };
    try { quickActionsToggle.setPointerCapture?.(event.pointerId); } catch { drag = undefined; }
  }, { signal: listeners.signal });
  quickActionsToggle.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    event.preventDefault();
    drag.moved = true;
    closeQuickActions();
    const rect = quickActionsToggle.getBoundingClientRect();
    const width = root.clientWidth;
    const height = root.clientHeight;
    const right = Math.max(8, Math.min(Math.max(8, width - rect.width - 8), drag.right - dx));
    const bottom = Math.max(8, Math.min(Math.max(8, height - rect.height - 8), drag.bottom - dy));
    quickActions.style.right = `${right}px`; quickActions.style.bottom = `${bottom}px`;
  }, { signal: listeners.signal });
  const finishDrag = (event?: PointerEvent) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    if (drag.moved) {
      quickActionsToggle.dataset.dragged = "true";
      try { localStorage.setItem("pi.quickActionsPosition", JSON.stringify({ right: parseFloat(quickActions.style.right), bottom: parseFloat(quickActions.style.bottom) })); } catch {}
    }
    const pointerId = drag.pointerId;
    drag = undefined;
    try { quickActionsToggle.releasePointerCapture?.(pointerId); } catch { /* Capture may already have been released. */ }
  };
  quickActionsToggle.addEventListener("pointerup", finishDrag, { signal: listeners.signal });
  quickActionsToggle.addEventListener("pointercancel", finishDrag, { signal: listeners.signal });
  quickActionsToggle.addEventListener("lostpointercapture", () => finishDrag(), { signal: listeners.signal });
  quickActionsToggle.addEventListener("click", event => {
    if (quickActionsToggle.dataset.dragged === "true" && event.detail !== 0) {
      delete quickActionsToggle.dataset.dragged;
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, { capture: true, signal: listeners.signal });
  on(nextStepButton, () => {
    closeQuickActions();
    quickActionsToggle.focus();
    if (!nextStepButton.hidden) runAnswerAction(options.onNextStep);
  });
  on(outlineButton, () => {
    closeQuickActions();
    quickActionsToggle.focus();
    if (!outlineButton.hidden) runAnswerAction(options.onOutline);
  });
  syncQuickActions();
  const outside = (event: Event) => {
    const target = event.target as Node;
    if (!moreMenu.contains(target) && !moreButton.contains(target)) {
      moreMenu.hidden = true;
      moreButton.setAttribute("aria-expanded", "false");
    }
    if (!quickActionsMenu.contains(target) && !quickActionsToggle.contains(target)) closeQuickActions();
  };
  document.addEventListener("pointerdown", outside, true);

  return {
    addUserMessage,
    appendAssistant,
    consume(event: ConversationEvent) {
      if (event.truncated) {
        const key = event.messageId || `${event.role || "message"}:${event.sessionId || ""}`;
        if (!truncationNotices.has(key)) {
          truncationNotices.add(key);
          notice("这条回复过长，界面仅显示前 120000 个字符；完整记录仍保存在本地。");
        }
      }
      if (event.role === "user") addUserMessage(cleanText(event.text), [], event.messageId);
      else if (event.role === "assistant") appendAssistant(cleanText(event.text), event.append ?? event.type !== "message", event.messageId);
    },
    restore(events: ConversationEvent[]) {
      const pending = optimisticUsers.map(item => item.text);
      clear();
      for (const event of events) {
        if (event.role === "user") {
          addUserMessage(cleanText(event.text), [], event.messageId);
          const index = pending.indexOf(cleanText(event.text));
          if (index >= 0) pending.splice(index, 1);
        } else if (event.role === "assistant") appendAssistant(cleanText(event.text), false, event.messageId);
      }
      for (const text of pending) addUserMessage(text);
    },
    setState,
    clear,
    latestAnswer: currentOrLatest,
    refreshQuickActions: syncQuickActions,
    setAssistantIcon(src: string) { if (src) applyIcon(src); },
    dispose() {
      disposed = true;
      listeners.abort();
      document.removeEventListener("pointerdown", outside, true);
      viewWindow?.removeEventListener("resize", constrainQuickActions);
      resizeObserver?.disconnect();
    },
  };
}
