/**
 * @seele/memory-client — browser-only entry point.
 *
 * Excludes server-only helpers (sync state, register device flow is
 * normally driven by the desktop CLI). Imports the same modules
 * through the public path so tsup bundles a single tree-shaken file.
 *
 * Consumers: `import { ... } from '@seele/memory-client/web'`.
 */

export * from './keytree.js'
export * from './grants.js'
export * from './recall.js'
export {
  SeeleCloudClient,
  BotSession,
  SeeleHttpError,
  DEFAULT_BASE_URL,
} from './client.js'
export type {
  SeeleCloudClientOptions,
  MintBotRequest,
  MintBotResponse,
  ListBotsResponse,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  SyncUploadRequest,
  SyncUploadResponse,
  SyncDownloadResponse,
  SyncStateResponse,
  SyncDevicesResponse,
} from './client.js'
