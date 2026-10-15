// ANSI is decoded by xterm. Only native approval menus with a known heading
// become buttons; ordinary numbered assistant text remains conversation text.
export function nativeQuestion(lines, provider) {
  const heading = provider === "codex"
    ? /Would you like to (?:run the following command|make the following edits)\?/
    : /Do you want to (?:proceed|run this command)\?/;
  const questionIndex = lines.findLastIndex(line => heading.test(line));
  if (questionIndex < 0) return null;
  const choices = [];
  let first = -1;
  for (let index = questionIndex + 1; index < lines.length; index++) {
    const match = /^\s*[›❯>]?\s*([1-9])\.\s+(.+?)\s*$/.exec(lines[index]);
    if (match) {
      if (choices.some(choice => choice.key === match[1])) return null;
      if (first < 0) first = index;
      choices.push({ key: match[1], label: match[2] });
    } else if (choices.length && /^\s{4,}\S/.test(lines[index]) && !/^\s*(Press |Esc |Enter )/.test(lines[index])) {
      choices.at(-1).label += `\n${lines[index].trim()}`;
    }
  }
  if (choices.length < 2 || choices[0].key !== "1" || !choices.some(choice => /^No\b/.test(choice.label))) return null;
  const toolHeading = lines.slice(0, questionIndex).findLastIndex(line => line.trim() === "Bash command");
  const start = provider === "codex" ? questionIndex : toolHeading >= 0 ? toolHeading : 0;
  let context = lines.slice(start, first);
  const border = context.findIndex(line => /^\s*[─╌━]{3,}\s*$/.test(line));
  if (provider === "claude" && border >= 0) context = context.slice(border + 1);
  const text = context.filter(line => !/^[\s─╌━]+$/.test(line)).join("\n").trim();
  return { text, choices, signature: JSON.stringify([provider, text, choices]) };
}
