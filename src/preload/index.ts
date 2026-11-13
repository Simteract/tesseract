import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/types'

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: unknown, value: T): void => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  listReviews: (filter) => ipcRenderer.invoke('reviews:list', filter),
  loadReview: (id, range) => ipcRenderer.invoke('review:load', id, range),
  loadBranch: (branch, range) => ipcRenderer.invoke('branch:load', branch, range),
  loadLocal: (range) => ipcRenderer.invoke('local:load', range),
  getFile: (revId) => ipcRenderer.invoke('file:get', revId),
  getBlueprintDiff: (args) => ipcRenderer.invoke('blueprint:diff', args),
  getAssetDiff: (args) => ipcRenderer.invoke('asset:diff', args),
  refreshComments: (modelKey) => ipcRenderer.invoke('comments:refresh', modelKey),
  addComment: (args) => ipcRenderer.invoke('comments:add', args),
  replyComment: (args) => ipcRenderer.invoke('comments:reply', args),
  editComment: (args) => ipcRenderer.invoke('comments:edit', args),
  deleteComment: (args) => ipcRenderer.invoke('comments:delete', args),
  setMyStatus: (args) => ipcRenderer.invoke('review:status', args),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  summarizeCluster: (args) => ipcRenderer.invoke('cluster:summarize', args),
  savedExplanations: (modelKey) => ipcRenderer.invoke('context:get', modelKey),
  explainContext: (args) => ipcRenderer.invoke('context:explain', args),
  clearExplanations: (args) => ipcRenderer.invoke('context:clear', args),
  storeSizes: () => ipcRenderer.invoke('stores:sizes'),
  clearStores: (kinds) => ipcRenderer.invoke('stores:clear', kinds),
  getPreReview: (modelKey) => ipcRenderer.invoke('prereview:get', modelKey),
  runPreReview: (modelKey) => ipcRenderer.invoke('prereview:run', modelKey),
  onPreReview: (listener) => subscribe('prereview', listener),
  getWalkthrough: (args) => ipcRenderer.invoke('walkthrough:get', args),
  runWalkthrough: (args) => ipcRenderer.invoke('walkthrough:run', args),
  onWalkthrough: (listener) => subscribe('walkthrough', listener),
  askWalkthrough: (args) => ipcRenderer.invoke('walkthrough:ask', args),
  buildClaudePrompt: (args) => ipcRenderer.invoke('claude:prompt', args),
  sendToClaude: (args) => ipcRenderer.invoke('claude:send', args),
  onProgress: (listener) => subscribe('progress', listener),
  cancelLoad: () => ipcRenderer.send('load:cancel'),
  getMcpInfo: () => ipcRenderer.invoke('mcp:info'),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  onUpdate: (listener) => subscribe('update', listener),
  installUpdate: () => ipcRenderer.send('update:install'),
  checkForUpdates: () => ipcRenderer.send('update:check'),
  reportSelection: (selection) => ipcRenderer.send('selection', selection),
  onOpenModel: (listener) => subscribe('mcp:open', listener),
  onSelect: (listener) => subscribe('mcp:select', listener),
  listDrafts: () => ipcRenderer.invoke('drafts:list'),
  onDrafts: (listener) => subscribe('drafts', listener),
  addDrafts: (fields) => ipcRenderer.invoke('drafts:add', fields),
  postDraft: (args) => ipcRenderer.invoke('drafts:post', args),
  deleteDraft: (id) => ipcRenderer.invoke('drafts:delete', id)
}

contextBridge.exposeInMainWorld('api', api)
