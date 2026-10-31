(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("pi.theme");
    if (saved === "light" || saved === "dark" || saved === "system") preference = saved;
  } catch {}
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const dark = preference === "dark" || (preference === "system" && systemDark);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
