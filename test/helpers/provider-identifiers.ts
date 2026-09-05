export const unsafeProviderIdentifiers = [
  '/private/provider/id', 'thread:/private/provider/id',
  'C:\\Users\\example\\id', 'thread:C:/Users/example/id',
  '\\\\server\\share\\id', 'thread://server/share/id',
  'file:notes,/private/provider/id', 'opaque;C:\\Users\\example\\id',
  'opaque (\\\\server\\share\\id)', 'file:notes,file:///private/provider/id',
] as const;

export const opaqueProviderIdentifiers = ['thread-01', 'opaque:Ab_C-9', 'relative/id', 'file:notes'] as const;
