export function applyLocalizedControlLabels(root: ParentNode, translate: (key: string) => string): void {
  root.querySelectorAll<HTMLElement>("[data-i18n-ph]").forEach((element) => {
    const key = element.dataset.i18nPh;
    if (!key) return;
    const placeholder = translate(key);
    element.setAttribute("placeholder", placeholder);

    const labels = (element as HTMLInputElement).labels;
    const hasTextLabel = [...(labels ?? [])].some((label) => !!label.textContent?.trim());
    const hasGeneratedLabel = element.dataset.i18nPlaceholderLabel === "true";
    if (hasTextLabel) {
      if (hasGeneratedLabel) {
        element.removeAttribute("aria-label");
        delete element.dataset.i18nPlaceholderLabel;
      }
      return;
    }

    if (!element.hasAttribute("aria-label") || hasGeneratedLabel) {
      element.setAttribute("aria-label", placeholder);
      element.dataset.i18nPlaceholderLabel = "true";
    }
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((element) => {
    const key = element.dataset.i18nAria;
    if (key) element.setAttribute("aria-label", translate(key));
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = element.dataset.i18nTitle;
    if (!key) return;
    const title = translate(key);
    element.setAttribute("title", title);
    element.setAttribute("aria-label", title);
  });
}
