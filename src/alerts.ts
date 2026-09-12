const TELEGRAM_MAX = 4096;
const CLIP_NOTE = "\n\n… (текст обрізано)";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatKyivTime(date: Date): string {
  const formatted = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${formatted} (Київ)`;
}

export function formatAlert(input: {
  text: string;
  keywords: string[];
  messageId: number;
  date: Date;
  channelUsername: string;
}): string {
  const username = input.channelUsername.replace(/^@/, "");
  const keys = input.keywords.map((key) => `<b>${escapeHtml(key)}</b>`).join(", ");
  const header = [
    `<b>Ключі:</b> ${keys}`,
    `<i>${escapeHtml(formatKyivTime(input.date))}</i>`,
    "",
  ].join("\n");
  const footer = `\n<a href="https://t.me/${username}/${input.messageId}">Оригінал поста</a>`;

  const budget = TELEGRAM_MAX - header.length - footer.length;
  let body = input.text;
  if (body.length > budget) {
    const room = Math.max(0, budget - CLIP_NOTE.length);
    body = `${body.slice(0, room).trimEnd()}${CLIP_NOTE}`;
  }
  return `${header}${escapeHtml(body)}${footer}`;
}
