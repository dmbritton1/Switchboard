export const unsafeProviderIdentifiers = [
  '/private/provider/id', 'thread:/private/provider/id',
  'C:\\Users\\example\\id', 'thread:C:/Users/example/id',
  '\\\\server\\share\\id', 'thread://server/share/id',
  'file:notes,/private/provider/id', 'opaque;C:\\Users\\example\\id',
  'opaque (\\\\server\\share\\id)', 'file:notes,file:///private/provider/id',
  'https://opaque.example//private/provider/id',
  'https://opaque.example/\\\\server\\share\\id',
  'urn:opaque:/thread-01//private/provider/id',
  'https://opaque.example/C:\\Users\\example\\id',
  'urn:opaque:/thread-01/C:\\Users\\example\\id',
  'https://opaque.example/file:///private/provider/id',
  'urn:opaque:/thread-01/file:///private/provider/id',
] as const;

export const opaqueProviderIdentifiers = [
  'thread-01', 'opaque:Ab_C-9', 'relative/id', 'file:notes',
  'https://opaque.example/thread-01', 'urn:opaque:/thread-01',
] as const;
