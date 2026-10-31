type Level = "info" | "error";
export function createTerminal() {
 const element = document.createElement("section"); element.id = "terminal-panel";
 element.setAttribute("aria-label", "Editor activity terminal");
 element.innerHTML = '<div class="terminal-toolbar"><span>Editor activity · this session</span><button type="button">Clear</button></div><div class="terminal-output" role="log" aria-label="Editor activity" aria-live="polite" aria-relevant="additions"></div>';
 const output = element.querySelector<HTMLElement>(".terminal-output")!;
 element.querySelector("button")!.onclick = () => output.replaceChildren();
 function log(message: string, level: Level = "info") {
  const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  const row = document.createElement("div"); row.className = `terminal-entry ${level}`;
  const time = document.createElement("time"); time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement("span"); text.textContent = `[${level.toUpperCase()}] ${message}`;
  row.append(time,text); output.append(row);
  while (output.childElementCount > 500) output.firstElementChild!.remove();
  if (follow) output.scrollTop = output.scrollHeight;
 }
 function watchNotices(notice: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = "";
  new MutationObserver(() => {
   const message = notice.textContent?.trim() ?? "";
   if (message === previous) return;
   previous = message; clearTimeout(timer);
   if (!message) return;
   log(message, /could not|cannot|failed|unavailable/i.test(message) ? "error" : "info");
   // Progress stays visible until the operation replaces or clears it.
   if (!message.endsWith("…")) timer = setTimeout(() => {
    if (notice.textContent?.trim() === message) notice.textContent = "";
   }, 5000);
  }).observe(notice,{childList:true,characterData:true,subtree:true});
 }
 log("Editor initialized. Activity is recorded here, including while this panel is closed.");
 return {element,log,watchNotices};
}
