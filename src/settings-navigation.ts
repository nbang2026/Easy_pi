const groups: Record<string, readonly string[]> = {
  connection: ["models"],
  personal: ["appearance", "sounds", "shortcuts"],
  resources: ["agents", "market", "skills", "extensions"],
  execution: ["harness", "usage"],
  system: ["system"],
};

export function setupSettingsNavigation(panel: HTMLElement, onSelect: (tab: string) => void) {
  const categories = [...panel.querySelectorAll<HTMLButtonElement>("[data-settings-group]")];
  const tabs = [...panel.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const remembered = new Map<string, string>();
  let current = "";
  const scroll = new Map<string, number>();
  const select = (requested: string, refresh = false) => {
    const group = Object.keys(groups).find(key => groups[key].includes(requested)) || "connection";
    const tab = groups[group].includes(requested) ? requested : "models";
    if (current === tab && !refresh) return tab;
    const content = panel.querySelector(".settings-content")!;
    if (current) scroll.set(current, content.scrollTop);
    current = tab;
    remembered.set(group, tab);
    for (const button of categories) {
      if (button.dataset.settingsGroup === group) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    for (const button of tabs) {
      button.hidden = !groups[group].includes(button.dataset.tab!);
      const active = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const pane of panel.querySelectorAll<HTMLElement>("[data-pane]")) {
      pane.hidden = pane.dataset.pane !== tab;
    }
    content.scrollTop = scroll.get(tab) || 0;
    onSelect(tab);
    return tab;
  };
  const click = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const category = target.closest<HTMLButtonElement>("[data-settings-group]");
    const tab = target.closest<HTMLButtonElement>("[data-tab]");
    if (category) {
      const group = category.dataset.settingsGroup!;
      select(remembered.get(group) || groups[group][0]);
    } else if (tab) select(tab.dataset.tab!);
  };
  const keydown = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const category = target.closest("[data-settings-group]");
    const tab = target.closest("[data-tab]");
    if (!category && !tab) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = category ? categories : tabs.filter(button => !button.hidden);
    const index = buttons.findIndex(button => category ? button === category : button.dataset.tab === current);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  };
  panel.addEventListener("click", click);
  panel.addEventListener("keydown", keydown);
  return { select, dispose() {
    panel.removeEventListener("click", click);
    panel.removeEventListener("keydown", keydown);
  } };
}
