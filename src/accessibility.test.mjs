import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";
import { applyLocalizedControlLabels } from "./accessibility.ts";
import { UI_STRINGS } from "./ui-strings.ts";

test("localized placeholders provide updated names for icon-only search labels", () => {
  const window = new Window();
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const labels = {
    en: {
      "ui.searchCommands": "Search commands",
      "ui.searchProviders": "Search providers",
      "settings.search": "Search models",
      "settings.keybindSearch": "Search actions",
      "market.search": "Search agents",
      "library.search": "Search library",
      "ph.provider": "Provider name",
      "ui.message": "Message",
      "ui.messageToPi": "Send a message to Pi…",
      "ui.executionEngine": "Execution engine",
      "title.thinking": "Thinking effort",
      "ui.workspaceScope": "Workspace scope",
      "ui.reviewScope": "Review scope",
      "ui.comparisonBranch": "Comparison branch",
      "ui.onlineSource": "Online source",
      "ui.agentCategory": "Agent category",
      "ui.libraryKind": "Library type",
      "ui.recentSessions": "Recent sessions",
      "ui.closeSidebar": "Close sidebar",
      "ui.conversationWorkspace": "Conversation workspace",
      "ui.conversation": "Conversation",
      "ui.answerActions": "Answer actions",
      "ui.copyAnswer": "Copy answer",
      "ui.moreActions": "More actions",
      "ui.moreConversationActions": "More conversation actions",
      "ui.agentSessions": "Agent sessions",
      "ui.input": "Input",
      "ui.inputAndWorkTools": "Input and work tools",
      "ui.claudeConnection": "Claude connection",
      "ui.workTools": "Work tools",
      "ui.application": "Application",
      "ui.fileContent": "File content",
      "ui.commandPalette": "Command palette",
      "ui.settingsCategories": "Settings categories",
      "ui.settingsTabs": "Settings pages",
      "market.sources": "Agent sources",
      "quickbar.title": "Quick commands",
      "sendmode.label": "Send mode",
      "conversation.quickActions": "Answer quick actions",
      "ui.workspace": "Workspace",
      "wallpaper.defaults": "Default wallpapers",
      "settings.wallpaperInk": "Wallpaper text color",
      "conversation.readAloud": "Read answer aloud",
      "conversation.regenerate": "Regenerate",
      "conversation.export": "Export answer",
      "conversation.clear": "Clear conversation",
      "conversation.continue": "Continue",
      "conversation.commandSuggestions": "Command suggestions",
    },
  };
  const translate = (key) => labels.en[key] || key;

  try {
    applyLocalizedControlLabels(window.document, translate);
    for (const [id, expected] of [
      ["quick-search", "Search commands"],
      ["provider-search", "Search providers"],
      ["model-search", "Search models"],
      ["keybind-search", "Search actions"],
      ["market-search", "Search agents"],
      ["library-search", "Search library"],
    ]) {
      const input = window.document.getElementById(id);
      assert.equal(input.getAttribute("placeholder"), expected);
      assert.equal(input.getAttribute("aria-label"), expected);
    }
    assert.equal(window.document.getElementById("provider-new-id").hasAttribute("aria-label"), false);
    for (const [id, expected] of [
      ["composer-input", "Message"],
      ["agent-select", "Execution engine"],
      ["thinking-select", "Thinking effort"],
      ["history-scope", "Workspace scope"],
      ["review-mode", "Review scope"],
      ["review-base", "Comparison branch"],
      ["market-provider", "Online source"],
      ["market-category", "Agent category"],
      ["library-kind", "Library type"],
    ]) {
      assert.equal(window.document.getElementById(id).getAttribute("aria-label"), expected);
    }
    assert.equal(window.document.getElementById("sound-switch").hasAttribute("aria-label"), false);

    const switched = (key) => `第二语言：${key}`;
    applyLocalizedControlLabels(window.document, switched);
    assert.equal(window.document.getElementById("quick-search").getAttribute("aria-label"), "第二语言：ui.searchCommands");
    assert.equal(window.document.getElementById("model-search").getAttribute("placeholder"), "第二语言：settings.search");
    assert.equal(window.document.getElementById("composer-input").getAttribute("placeholder"), "第二语言：ui.messageToPi");
    assert.equal(window.document.getElementById("agent-select").getAttribute("aria-label"), "第二语言：ui.executionEngine");
  } finally {
    window.happyDOM.abort();
  }
});

test("all static non-file form fields have an accessible name after localization", () => {
  const window = new Window();
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const translate = (key) => UI_STRINGS.en[key] || UI_STRINGS.zh[key] || key;

  try {
    applyLocalizedControlLabels(window.document, translate);
    const unnamed = [...window.document.querySelectorAll("input:not([type=hidden]), textarea, select")]
      .filter((element) => !(element.type === "file" && element.hidden))
      .filter((element) => {
        const hasLabelText = [...(element.labels ?? [])].some((label) => !!label.textContent?.trim());
        return !hasLabelText
          && !element.getAttribute("aria-label")
          && !element.getAttribute("aria-labelledby")
          && !element.title;
      })
      .map((element) => element.id || element.outerHTML);

    assert.deepEqual(unnamed, []);
  } finally {
    window.happyDOM.abort();
  }
});

test("every static ARIA name is sourced from a localized key and updates with the language", () => {
  const window = new Window();
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const labels = {
    ...UI_STRINGS.en,
    "quickbar.title": "Quick commands",
    "sendmode.label": "Send mode",
    "title.thinking": "Thinking effort",
  };
  const translate = (key) => labels[key] || `EN:${key}`;

  try {
    const missingKeys = [...window.document.querySelectorAll("[aria-label]")]
      .filter((element) => !element.hasAttribute("data-i18n-aria") && !element.hasAttribute("data-i18n-title"))
      .map((element) => element.id || element.getAttribute("aria-label"));
    assert.deepEqual(missingKeys, []);

    applyLocalizedControlLabels(window.document, translate);
    for (const element of window.document.querySelectorAll("[data-i18n-aria], [data-i18n-title]")) {
      const key = element.dataset.i18nTitle || element.dataset.i18nAria;
      if (!key || !element.hasAttribute("aria-label")) continue;
      assert.equal(element.getAttribute("aria-label"), translate(key));
      if (element.hasAttribute("data-i18n-title")) assert.equal(element.title, translate(key));
    }
    assert.deepEqual(
      [...window.document.querySelectorAll("#conversation-more-menu [role=menuitem] span")].map((element) => element.dataset.i18n),
      ["conversation.readAloud", "conversation.regenerate", "conversation.export", "conversation.clear"],
    );
  } finally {
    window.happyDOM.abort();
  }
});
