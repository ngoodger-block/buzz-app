# View a Pi session started by Buzz

Buzz runs Pi through `buzz-pi-acp`. It keeps one index file per session in
`~/.pi/buzz-pi-acp/sessions/`. Each index records the Pi JSONL path, sometimes a
title, and sometimes the exact system prompt. The JSONL itself lives under
`~/.pi/agent/sessions/`.

## Find the session

Start from the Buzz link to the thread. In its `buzz://message` link, take the
64-character `thread=` value, or `id=` when the link has no `thread=`. That is
the thread root. Turns inside the thread record `Thread root: <id>` in the Pi
transcript. A top-level mention that started the thread records only
`Event ID: <id>`. Search the indexed sessions for either:

```sh
root='<thread-root-id>'
for index in ~/.pi/buzz-pi-acp/sessions/*.json; do
  session=$(jq -r '.session.sessionFile' "$index")
  if [ -f "$session" ] &&
    rg -q -F -e "Thread root: $root" -e "Event ID: $root" "$session"; then
    jq -r --arg index "$index" \
      '[.session.updatedAt, .session.sessionTitle // "-", .session.sessionFile, $index] | @tsv' \
      "$index"
  fi
done
```

Usually exactly one session matches. If more match, check the update time
against the Buzz thread before exporting. A channel-scoped session can contain
several Buzz threads.

## Export and open HTML

```sh
index='/path/to/matching-index.json'
session=$(jq -r '.session.sessionFile' "$index")
pi --export "$session" session.html
open session.html # macOS; otherwise open the file in a browser
```

The HTML file contains the session conversation and tool activity. Keep it local
unless you intend to share that content.

Pi's HTML export omits the system prompt. If the index recorded one, view it
separately:

```sh
jq -r '.session.systemPrompt.text // "No recorded system prompt"' "$index"
```
