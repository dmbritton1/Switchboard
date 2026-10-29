export function codexCommands(snapshot, preview = false) {
  const builtins = preview ? [] : [
    ['compact', 'Compact the conversation context'], ['skills', 'Browse skills and plugin skills'],
    ['apps', 'Browse connected apps'], ['mcp', 'Browse MCP tools'],
  ].map(([name, description]) => ({name, description, available:true}));
  return [...builtins, ...(snapshot?.capabilities ?? []).map(item => ({...item, name:item.alias}))];
}
export function searchCommands(text, caret, entries) {
  if (!text.startsWith('/')) return null;
  const whitespace = text.search(/\s/);
  const end = whitespace < 0 ? text.length : whitespace;
  if (caret > end) return null;
  const query = text.slice(1,end).toLowerCase();
  const matches = entries.filter(item => `${item.name} ${item.description ?? ''} ${item.displayName ?? ''}`.toLowerCase().includes(query))
    .sort((a,b)=>Number(!a.name.toLowerCase().startsWith(query))-Number(!b.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name))
    .map(item=>item.name);
  return matches.length ? {query,matches} : null;
}
export function capabilityFilter(text) {
 const match = /^\/(skills|apps|mcp)(?:\s+(.*))?$/s.exec(text.trim());
 return match ? {kind:{skills:'skill',apps:'app',mcp:'mcp-tool'}[match[1]],query:match[2] ?? ''} : null;
}
