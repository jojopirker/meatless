import { basename } from 'node:path';

export const toolValue = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
export const toolText = (content = []) => content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

export function toolMessage(id, name, status, input, output = '') {
  return { id, role: 'tool', name, status, input: toolValue(input), output: toolValue(output) };
}

// App-server items. Saved desktop items are converted to this shape by their adapter.
export function codexTool(item) {
  switch (item.type) {
    case 'commandExecution':
      return toolMessage(item.id, 'Run command', item.status, item.command, item.aggregatedOutput ?? '');
    case 'mcpToolCall':
      return toolMessage(item.id, `${item.server} / ${item.tool}`, item.status, item.arguments,
        item.error?.message ?? (toolText(item.result?.content) || toolValue(item.result?.structuredContent)));
    case 'dynamicToolCall':
      return toolMessage(item.id, item.tool, item.status, item.arguments,
        (item.contentItems ?? []).filter((part) => part.type === 'inputText').map((part) => part.text).join('\n'));
    case 'fileChange':
      return toolMessage(item.id, 'Edit files', item.status,
        item.changes.map((change) => `${basename(change.path)}\n${change.diff}`).join('\n\n'));
    case 'webSearch':
      return toolMessage(item.id, 'Search the web', item.status ?? 'completed', item.action ?? item.query);
  }
}
