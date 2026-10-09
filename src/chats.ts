export type ChatRef = {
  chatId: number;
  title: string;
};

export type ResolveChatResult<T extends ChatRef> =
  | { ok: true; chat: T; rest: string }
  | { ok: false; reason: "empty" | "not_found" | "ambiguous"; matches: T[] };

export function matchChats<T extends ChatRef>(query: string, chats: T[]): T[] {
  const needle = query.trim().toLocaleLowerCase("uk");
  if (!needle) {
    return [];
  }
  const exact = chats.filter((chat) => chat.title.toLocaleLowerCase("uk") === needle);
  if (exact.length > 0) {
    return exact;
  }
  return chats.filter((chat) => chat.title.toLocaleLowerCase("uk").includes(needle));
}

export function resolveChatCommand<T extends ChatRef>(
  args: string,
  chats: T[],
): ResolveChatResult<T> {
  const trimmed = args.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty", matches: [] };
  }

  const argsLower = trimmed.toLocaleLowerCase("uk");
  const byLength = [...chats].sort((a, b) => b.title.length - a.title.length);
  for (const chat of byLength) {
    const titleLower = chat.title.toLocaleLowerCase("uk");
    if (argsLower === titleLower || argsLower.startsWith(`${titleLower} `)) {
      return { ok: true, chat, rest: trimmed.slice(titleLower.length).trim() };
    }
  }

  const [head = "", ...tail] = trimmed.split(/\s+/);
  const matches = matchChats(head, chats);
  const only = matches[0];
  if (matches.length === 1 && only) {
    return { ok: true, chat: only, rest: tail.join(" ").trim() };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", matches };
  }
  return { ok: false, reason: "not_found", matches: [] };
}
