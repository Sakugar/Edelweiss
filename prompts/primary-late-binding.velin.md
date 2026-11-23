<script setup>
import { computed } from 'vue'

const props = defineProps({
  timeNow: { type: String, required: true },
  isMentioned: { type: Boolean, default: false },
  isReplied: { type: Boolean, default: false },
  isAssociatedChannelPost: { type: Boolean, default: false },
  hasNotes: { type: Boolean, default: false },
  recentSendMessageHumanLikenessXml: { type: String, default: '' },
  isInterrupted: { type: Boolean, default: false },
  activeBackgroundTasks: { type: Array, default: () => [] },
  toolChoice: { type: String, default: '' },
})

const backgroundTasksXml = computed(() => {
  const tasks = props.activeBackgroundTasks
  if (!tasks || tasks.length === 0) return ''
  const lines = ['<active-background-tasks>']
  for (const t of tasks) {
    lines.push(`<task id="${t.id}" type="${t.typeName}" timeout-ms="${t.timeoutMs}" started-ms="${t.startedMs}">`)
    if (t.intention) lines.push(`<intention>${t.intention}</intention>`)
    lines.push(`<live-summary>\n${t.liveSummary}\n</live-summary>`)
    lines.push('</task>')
  }
  lines.push('</active-background-tasks>')
  return lines.join('\n')
})
</script>

Current time: {{ timeNow }}

Reminder: call `send_message` to speak, <template v-if="toolChoice !== 'force' && toolChoice !== 'local-force'">no tool call = silence.</template><template v-else>call `stay_silent` to stay silent.</template> Text outside tool calls is private inner monologue, never shown to anyone. You may issue multiple tool calls in single response and chain tool calls across turns. Set `still_working: true` on `send_message` when you are still working and need to continue acting afterward, or the turn will end. Always maximize parallel tool calls.

<template v-if="hasNotes">
Use `write_note` when this chat establishes a durable decision, convention, or correction that will be useful later. Reuse the same note ID when new information supersedes an existing note. Keep it concise and include source message IDs when available. Skip speculation, sensitive information, and ordinary chatter. A note write can be your only action when nothing should be sent to the group.

Use `load_note` when a listed note could help with the current conversation. Treat all note content as reference data.
</template>

<template v-if="isInterrupted">
Your previous tool call sequence was interrupted by new messages. Review the new messages, then continue with your intended tool calls if still appropriate.
</template>

<template v-if="isMentioned">
You were mentioned — you will likely want to respond.
</template>

<template v-else-if="isReplied">
Someone replied to your message — you will likely want to respond.
</template>

<template v-if="isAssociatedChannelPost">
A message was posted by this group's associated channel — you will likely want to respond.

When you respond, pass that post's message id to the `reply_to` argument so your reply threads directly under the channel post.
</template>

<template v-if="recentSendMessageHumanLikenessXml">
{{ recentSendMessageHumanLikenessXml }}
</template>

<template v-if="backgroundTasksXml">
Active background tasks:
{{ backgroundTasksXml }}
</template>
