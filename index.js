import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, readlink, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MARKER = '.dsh-session-folder.json'
const INITIAL_TITLE = '新对话'
const TITLE_LIMIT = 80

/** @type {Map<string, string>} session id -> real conversation folder */
const folderBySession = new Map()
/** @type {Map<string, string>} session id -> last known title */
const titleBySession = new Map()
/** @type {Map<string, Promise<unknown>>} session id -> creation/resume coordination */
const sessionLocks = new Map()
/** @type {Map<string, ReturnType<typeof setTimeout>>} session id -> pending disposal check */
const disposalTimers = new Map()
/** @type {Map<string, ReturnType<typeof setTimeout>>} session id -> pending empty-folder check */
const emptyCleanupTimers = new Map()
/** Sessions for which this plugin owns a conversation folder lifecycle. */
const managedSessions = new Set()
/** @type {Set<string>} sessions with an open turn */
const activeTurns = new Set()
/** True while the plugin is being disposed; prevents host shutdown from deleting folders. */
let pluginClosing = false
/** @type {import('@deepseek-ai/cordis').Context | undefined} */
let pluginCtx

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function optionalService(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

function workspaceContainsSession(ctx, sessionId) {
  try {
    const list = ctx?.workspaceRegistry?.list?.() ?? []
    return list.some(workspace => workspace?.sessionIds?.includes?.(sessionId) === true)
  } catch {
    // If workspace state cannot be read, do not delete anything.
    return true
  }
}

function logger(ctx, level, message) {
  try {
    const target = ctx ?? pluginCtx
    const log = target?.logger?.[level]
    if (typeof log === 'function') log.call(target.logger, message)
  } catch {
    // Logging must never break conversation creation.
  }
}

function stripExtendedPathPrefix(value) {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  if (value.startsWith('\\\\?\\')) return value.slice(4)
  if (value.startsWith('\\??\\UNC\\')) return `\\\\${value.slice(8)}`
  if (value.startsWith('\\??\\')) return value.slice(4)
  return value
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try {
    const left = path.resolve(stripExtendedPathPrefix(a))
    const right = path.resolve(stripExtendedPathPrefix(b))
    return process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right
  } catch {
    return false
  }
}

function isInside(child, parent) {
  const relative = path.relative(
    path.resolve(stripExtendedPathPrefix(parent)),
    path.resolve(stripExtendedPathPrefix(child)),
  )
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function sanitizeTitle(value) {
  let title = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (title.length === 0) title = INITIAL_TITLE
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(title)) title = `_${title}`
  const characters = Array.from(title)
  if (characters.length > TITLE_LIMIT) title = characters.slice(0, TITLE_LIMIT).join('').trimEnd()
  return title || INITIAL_TITLE
}

function folderNameFor(title, sessionId, attempt = 0) {
  const safeTitle = sanitizeTitle(title)
  const suffix = attempt === 0 ? `-${sessionId}` : ` (${attempt + 1})-${sessionId}`
  return `${safeTitle}${suffix}`
}

function titleOf(ctx, session) {
  const fromEvent = titleBySession.get(session.id)
  if (fromEvent) return fromEvent
  try {
    const snapshot = ctx?.sessionTitle?.get?.(session)
    if (snapshot?.title) return snapshot.title
  } catch {
    // A title service may not be available in a minimal composition.
  }
  return INITIAL_TITLE
}

function workspaceOf(ctx, session) {
  let list = []
  try {
    list = ctx?.workspaceRegistry?.list?.() ?? []
  } catch {
    return undefined
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const exact = list.find(workspace => samePath(workspace.path, cwd))
    if (exact) return exact
    const containing = list.find(workspace => isInside(cwd, workspace.path))
    if (containing) return containing
  }
  return list.find(workspace => workspace.sessionIds?.includes?.(session.id))
}

async function isDirectory(value) {
  try {
    return (await stat(value)).isDirectory()
  } catch {
    return false
  }
}

async function exists(value) {
  try {
    await lstat(value)
    return true
  } catch {
    return false
  }
}

function hasActiveSessionJobs(ctx, sessionId) {
  const jobs = optionalService(ctx, 'jobs')
  if (!jobs || typeof jobs.list !== 'function') return false
  try {
    return jobs.list(sessionId).some(job =>
      job?.owner === sessionId && (job.status === 'running' || job.status === 'stopping'))
  } catch {
    return false
  }
}

async function isConversationFolderEmpty(folder) {
  try {
    const entries = await readdir(folder, { withFileTypes: true })
    return entries.every(entry => entry.name === MARKER)
  } catch {
    return false
  }
}

async function findExistingFolder(workspacePath, sessionId) {
  let entries
  try {
    entries = await readdir(workspacePath, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === sessionId || entry.name.endsWith(`-${sessionId}`)) {
      return path.join(workspacePath, entry.name)
    }
  }
  return undefined
}

async function findFolderAnywhere(ctx, sessionId) {
  const remembered = folderBySession.get(sessionId)
  if (remembered && await isDirectory(remembered)) return remembered
  let list = []
  try {
    list = ctx?.workspaceRegistry?.list?.() ?? []
  } catch {
    return undefined
  }
  for (const workspace of list) {
    const found = await findExistingFolder(workspace.path, sessionId)
    if (found) return found
  }
  return undefined
}

function aliasRoot() {
  // Keep the effective cwd ASCII even when the Windows user name is Chinese.
  // PUBLIC and ProgramData are machine-wide ASCII paths by default.
  const candidates = []
  if (process.env.PUBLIC) candidates.push(path.join(process.env.PUBLIC, 'dsh-session-folders', 'aliases'))
  if (process.env.ProgramData) candidates.push(path.join(process.env.ProgramData, 'dsh-session-folders', 'aliases'))
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  candidates.push(path.join(localAppData, 'dsh-session-folders', 'aliases'))
  return candidates.find(candidate => /^[\x20-\x7e]+$/.test(candidate)) ?? candidates[candidates.length - 1]
}

async function removeAlias(sessionId) {
  const link = path.join(aliasRoot(), sessionId)
  try {
    await unlink(link)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    try {
      await rmdir(link)
    } catch {
      // Best effort: a stale junction is harmless and is replaced on the next run.
    }
  }
}

async function ensureAlias(sessionId, target) {
  const root = aliasRoot()
  await mkdir(root, { recursive: true })
  const link = path.join(root, sessionId)
  let current
  try {
    current = await readlink(link)
  } catch {
    current = undefined
  }
  if (current !== undefined && samePath(current, target) && await exists(link)) return link
  await removeAlias(sessionId)
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return link
  } catch (error) {
    logger(undefined, 'warn', `dsh-session-folders: could not create ASCII junction for ${JSON.stringify(target)}: ${String(error)}`)
    return target
  }
}

async function setHidden(target, hidden) {
  if (process.platform !== 'win32') return
  try {
    await execFileAsync('attrib.exe', [hidden ? '+H' : '-H', target], { windowsHide: true })
  } catch (error) {
    logger(undefined, 'warn', `dsh-session-folders: could not ${hidden ? 'hide' : 'unhide'} ${JSON.stringify(target)}: ${String(error)}`)
  }
}

async function writeMarker(folder, sessionId, title, archived, alias) {
  const marker = path.join(folder, MARKER)
  const payload = {
    schema: 1,
    sessionId,
    title,
    archived,
    alias,
    updatedAt: new Date().toISOString(),
  }
  try {
    // Windows may refuse to open a hidden file for writing with FILE_ATTRIBUTE_NORMAL.
    if (await exists(marker)) await setHidden(marker, false)
    await writeFile(marker, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await setHidden(marker, true)
  } catch (error) {
    logger(undefined, 'warn', `dsh-session-folders: could not write folder marker: ${String(error)}`)
  }
}

async function renameFolder(from, to) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(from, to)
      return true
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) break
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
  logger(undefined, 'warn', `dsh-session-folders: could not rename ${JSON.stringify(from)} to ${JSON.stringify(to)}: ${String(lastError)}`)
  return false
}

async function allocateFolder(workspacePath, sessionId, title) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = path.join(workspacePath, folderNameFor(title, sessionId, attempt))
    if (!await exists(candidate)) return candidate
  }
  return path.join(workspacePath, folderNameFor(title, sessionId, Date.now()))
}

async function syncFolderName(folder, sessionId, title, alias) {
  const desired = folderNameFor(title, sessionId)
  if (path.basename(folder) === desired) return folder
  let target = path.join(path.dirname(folder), desired)
  for (let attempt = 1; await exists(target) && attempt < 100; attempt += 1) {
    target = path.join(path.dirname(folder), folderNameFor(title, sessionId, attempt))
  }
  if (await renameFolder(folder, target)) {
    folderBySession.set(sessionId, target)
    await writeMarker(target, sessionId, title, false, alias)
    return target
  }
  return folder
}

async function pointWorkingDirectory(ctx, session, directory) {
  try {
    const current = ctx?.workingDirectory?.get?.(session)
    if (typeof current !== 'string' || !samePath(current, directory)) {
      session.append('working-directory/change', { cwd: directory })
    }
  } catch (error) {
    logger(ctx, 'warn', `dsh-session-folders: could not set effective working directory: ${String(error)}`)
  }
}

function isSessionArchived(ctx, sessionId) {
  try {
    return ctx?.workspaceRegistry?.archivedSessionIds?.includes?.(sessionId) === true
  } catch {
    return false
  }
}

async function ensureConversationFolder(ctx, session, create) {
  const workspace = workspaceOf(ctx, session)
  if (!workspace) return undefined
  const sessionId = session.id
  const title = titleOf(ctx, session)
  let folder = folderBySession.get(sessionId)
  if (!folder || !await isDirectory(folder)) folder = await findExistingFolder(workspace.path, sessionId)
  if (!folder) {
    if (!create) return undefined
    folder = await allocateFolder(workspace.path, sessionId, title)
    await mkdir(folder, { recursive: true })
  }
  folder = await syncFolderName(folder, sessionId, title, path.join(aliasRoot(), sessionId))
  // Keep the folder hidden while the conversation is still archived. The
  // unarchive event owns making it visible again.
  if (!isSessionArchived(ctx, sessionId)) await setHidden(folder, false)
  const alias = await ensureAlias(sessionId, folder)
  folderBySession.set(sessionId, folder)
  titleBySession.set(sessionId, title)
  await writeMarker(folder, sessionId, title, false, alias)
  await pointWorkingDirectory(ctx, session, alias)
  logger(ctx, 'info', `dsh-session-folders: conversation ${sessionId} runs in ${JSON.stringify(alias)} -> ${JSON.stringify(folder)}`)
  return { folder, alias }
}

async function withLock(sessionId, action) {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(action)
  sessionLocks.set(sessionId, operation)
  try {
    return await operation
  } finally {
    if (sessionLocks.get(sessionId) === operation) sessionLocks.delete(sessionId)
  }
}

async function stopSessionJobs(ctx, sessionId) {
  const jobs = optionalService(ctx, 'jobs')
  if (!jobs || typeof jobs.list !== 'function' || typeof jobs.kill !== 'function') return
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let active = []
    try {
      active = jobs.list(sessionId).filter(job =>
        job?.owner === sessionId && (job.status === 'running' || job.status === 'stopping'))
    } catch (error) {
      logger(ctx, 'warn', `dsh-session-folders: could not list jobs for ${sessionId}: ${String(error)}`)
      return
    }
    if (active.length === 0) return
    for (const job of active) {
      try {
        jobs.kill(job.id, sessionId, 'session deleted')
      } catch (error) {
        logger(ctx, 'warn', `dsh-session-folders: could not stop job ${job.id}: ${String(error)}`)
      }
    }
    await sleep(250)
  }
}

async function stopProcessesUnder(paths) {
  if (process.platform !== 'win32') return 0
  const unique = [...new Set(paths.filter(value => typeof value === 'string' && value.length > 0))]
  if (unique.length === 0) return 0
  const needles = unique.map(value => `'${value.replace(/'/g, "''")}'`).join(', ')
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needles = @(${needles})`,
    '$self = $PID',
    '$targets = @()',
    'foreach ($process in @(Get-CimInstance Win32_Process)) {',
    '  if (-not $process -or $process.ProcessId -eq $self) { continue }',
    '  $commandLine = [string]$process.CommandLine',
    '  $executable = [string]$process.ExecutablePath',
    '  foreach ($needle in $needles) {',
    '    if ($commandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $executable.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {',
    '      $targets += [int]$process.ProcessId',
    '      break',
    '    }',
    '  }',
    '}',
    '$targets = @($targets | Select-Object -Unique)',
    'foreach ($targetId in $targets) { & taskkill.exe /PID $targetId /T /F 2>$null | Out-Null }',
    'Write-Output $targets.Count',
  ].join('\n')
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
    )
    const count = Number.parseInt(String(stdout).trim(), 10)
    if (Number.isFinite(count) && count > 0) {
      logger(undefined, 'info', `dsh-session-folders: stopped ${count} process(es) under ${JSON.stringify(unique)}`)
    }
    return Number.isFinite(count) ? count : 0
  } catch (error) {
    logger(undefined, 'warn', `dsh-session-folders: process cleanup failed: ${String(error)}`)
    return 0
  }
}

async function removeFolderWithRetry(folder) {
  let lastError
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(folder, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return true
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) break
      await sleep(250 * (attempt + 1))
    }
  }
  logger(undefined, 'warn', `dsh-session-folders: could not delete ${JSON.stringify(folder)}: ${String(lastError)}`)
  return false
}

async function deleteConversationFolder(ctx, sessionId) {
  const folder = await findFolderAnywhere(ctx, sessionId)
  const alias = path.join(aliasRoot(), sessionId)
  await stopSessionJobs(ctx, sessionId)
  if (folder) await setHidden(folder, false)
  await stopProcessesUnder([folder, alias].filter(Boolean))
  // A process can release a file handle just after taskkill; try once more
  // after the alias is removed, then let the rm retry loop handle the rest.
  await removeAlias(sessionId)
  await sleep(150)
  await stopProcessesUnder([folder, alias].filter(Boolean))
  let removed = true
  if (folder) removed = await removeFolderWithRetry(folder)
  if (removed) {
    folderBySession.delete(sessionId)
    titleBySession.delete(sessionId)
    managedSessions.delete(sessionId)
    logger(ctx, 'info', `dsh-session-folders: deleted conversation folder for ${sessionId}`)
  }
}

async function removeEmptyConversationFolder(ctx, sessionId) {
  if (pluginClosing || activeTurns.has(sessionId)) return
  if (!managedSessions.has(sessionId) || isSessionArchived(ctx, sessionId)) return
  if (hasActiveSessionJobs(ctx, sessionId)) return
  const folder = await findFolderAnywhere(ctx, sessionId)
  if (!folder) {
    folderBySession.delete(sessionId)
    return
  }
  if (!await isConversationFolderEmpty(folder)) return
  const marker = path.join(folder, MARKER)
  await setHidden(folder, false)
  if (await exists(marker)) await setHidden(marker, false)
  await removeAlias(sessionId)
  const removed = await removeFolderWithRetry(folder)
  if (removed) {
    folderBySession.delete(sessionId)
    logger(ctx, 'info', `dsh-session-folders: removed empty conversation folder for ${sessionId}`)
  } else {
    // If a file handle or antivirus scanner temporarily blocks deletion,
    // restore the alias so the next turn can still use the conversation folder.
    await ensureAlias(sessionId, folder)
  }
}

function scheduleEmptyCleanup(ctx, sessionId) {
  if (pluginClosing || !managedSessions.has(sessionId)) return
  const previous = emptyCleanupTimers.get(sessionId)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    emptyCleanupTimers.delete(sessionId)
    void withLock(sessionId, () => removeEmptyConversationFolder(ctx, sessionId)).catch(error => {
      logger(ctx, 'warn', `dsh-session-folders: empty-folder cleanup failed: ${String(error)}`)
    })
  }, 600)
  emptyCleanupTimers.set(sessionId, timer)
}

async function handlePreStep(ctx, agent) {
  const session = agent?.session
  if (!session || session.header?.origin === 'subagent') return
  if (!managedSessions.has(session.id) || isSessionArchived(ctx, session.id)) return
  await withLock(session.id, () => ensureConversationFolder(ctx, session, true))
}

/**
 * The working-directory service validates the current directory from its
 * system-prompt hook before `agent/pre-step` runs. If the empty-folder
 * cleanup just removed the alias, that validation would otherwise commit the
 * original workspace cwd, so every later tool would run outside the
 * conversation folder. Recreate the folder and alias before the service
 * validates it.
 */
async function handleWorkingDirectoryAccess(ctx, request, next) {
  if (request?.path === null) {
    const session = request?.agent?.session
    if (session && session.header?.origin !== 'subagent'
      && managedSessions.has(session.id) && !isSessionArchived(ctx, session.id)) {
      try {
        await withLock(session.id, () => ensureConversationFolder(ctx, session, true))
      } catch (error) {
        logger(ctx, 'warn', `dsh-session-folders: working-directory restore failed: ${String(error)}`)
      }
    }
  }
  return next()
}

async function handleSessionDisposed(ctx, sessionId) {
  // dsh-session-manager detaches the live session before it removes the
  // persisted files and workspace attachment. Wait for both to disappear so
  // an ordinary dispose (clear, reload, host shutdown) is never destructive.
  await sleep(600)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (pluginClosing) return
    const persistence = optionalService(ctx, 'sessionPersistence')
    if (!persistence || typeof persistence.stat !== 'function') {
      folderBySession.delete(sessionId)
      titleBySession.delete(sessionId)
      managedSessions.delete(sessionId)
      return
    }
    let stored = true
    try {
      stored = (await persistence.stat(sessionId)) !== undefined
    } catch {
      stored = true
    }
    const inWorkspace = workspaceContainsSession(ctx, sessionId)
    if (!stored && !inWorkspace) {
      await withLock(sessionId, () => deleteConversationFolder(ctx, sessionId))
      return
    }
    await sleep(300)
  }
  // The session is still stored or still attached; leave its folder alone.
  folderBySession.delete(sessionId)
  titleBySession.delete(sessionId)
  managedSessions.delete(sessionId)
}

function scheduleSessionDisposed(ctx, sessionId) {
  if (pluginClosing) return
  const previous = disposalTimers.get(sessionId)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    disposalTimers.delete(sessionId)
    void handleSessionDisposed(ctx, sessionId).catch(error => {
      logger(ctx, 'warn', `dsh-session-folders: session disposal cleanup failed: ${String(error)}`)
    })
  }, 500)
  disposalTimers.set(sessionId, timer)
}

async function handleAgentCreated(ctx, agent, source) {
  const session = agent?.session
  if (!session) return
  if (session.header?.origin === 'subagent') return
  // Only a genuinely new conversation gets a new folder. A resumed session
  // restores its existing folder, but does not create one retroactively.
  // The one exception is a session whose working directory is already this
  // plugin's alias: that folder was removed after an empty turn, so recreate
  // it on resume (for example after a host restart).
  let previousDirectory
  try {
    previousDirectory = ctx?.workingDirectory?.get?.(session)
  } catch {
    previousDirectory = undefined
  }
  const managedAlias = typeof previousDirectory === 'string'
    && samePath(previousDirectory, path.join(aliasRoot(), session.id))
  const create = source !== 'resume' || managedAlias
  let result
  // A workspace added just before the first conversation may not be visible in
  // workspaceRegistry.list() yet. Retry briefly before giving up, otherwise the
  // new conversation would run without its folder.
  for (let attempt = 0; attempt < 8 && !result; attempt += 1) {
    result = await withLock(session.id, () => ensureConversationFolder(ctx, session, create))
    if (result || !create || attempt === 7) break
    await sleep(200)
  }
  if (result) managedSessions.add(session.id)
}

async function handleTitle(ctx, session, event) {
  if (session?.header?.origin === 'subagent') return
  const title = String(event?.data?.title ?? '').trim()
  if (!title) return
  titleBySession.set(session.id, title)
  await withLock(session.id, async () => {
    const workspace = workspaceOf(ctx, session)
    if (!workspace) return
    let folder = folderBySession.get(session.id)
    if (!folder || !await isDirectory(folder)) folder = await findExistingFolder(workspace.path, session.id)
    if (!folder) return
    const alias = path.join(aliasRoot(), session.id)
    folder = await syncFolderName(folder, session.id, title, alias)
    const effectiveAlias = await ensureAlias(session.id, folder)
    folderBySession.set(session.id, folder)
    await writeMarker(folder, session.id, title, false, effectiveAlias)
    await pointWorkingDirectory(ctx, session, effectiveAlias)
  })
}

async function handleArchived(ctx, sessionId) {
  await withLock(sessionId, async () => {
    const folder = await findFolderAnywhere(ctx, sessionId)
    if (!folder) return
    await removeAlias(sessionId)
    await setHidden(folder, true)
    const title = titleBySession.get(sessionId) ?? path.basename(folder).replace(new RegExp(`-${sessionId}$`), '')
    await writeMarker(folder, sessionId, title, true, path.join(aliasRoot(), sessionId))
    logger(ctx, 'info', `dsh-session-folders: hid archived conversation folder ${JSON.stringify(folder)}`)
  })
}

async function handleUnarchiving(ctx, sessionId) {
  await withLock(sessionId, async () => {
    const folder = await findFolderAnywhere(ctx, sessionId)
    if (!folder) return
    await setHidden(folder, false)
    const alias = await ensureAlias(sessionId, folder)
    const title = titleBySession.get(sessionId) ?? path.basename(folder).replace(new RegExp(`-${sessionId}$`), '')
    folderBySession.set(sessionId, folder)
    managedSessions.add(sessionId)
    await writeMarker(folder, sessionId, title, false, alias)
    logger(ctx, 'info', `dsh-session-folders: restored conversation folder ${JSON.stringify(folder)}`)
  })
}

export const inject = ['workspaceRegistry', 'workingDirectory', 'sessionTitle']

export function apply(ctx) {
  pluginCtx = ctx
  pluginClosing = false
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      pluginClosing = true
      for (const timer of disposalTimers.values()) clearTimeout(timer)
      disposalTimers.clear()
      for (const timer of emptyCleanupTimers.values()) clearTimeout(timer)
      emptyCleanupTimers.clear()
      activeTurns.clear()
      managedSessions.clear()
    })
  }
  ctx.on('agent/created', async payload => {
    try {
      await handleAgentCreated(ctx, payload?.agent, payload?.source)
    } catch (error) {
      logger(ctx, 'warn', `dsh-session-folders: agent/created failed: ${String(error)}`)
    }
  })

  ctx.on('working-directory/access', async (request, next) => {
    return handleWorkingDirectoryAccess(ctx, request, next)
  }, { prepend: true })

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      await handlePreStep(ctx, payload?.agent)
    } catch (error) {
      logger(ctx, 'warn', `dsh-session-folders: pre-step folder restore failed: ${String(error)}`)
    }
    return next()
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'session/title') {
      void handleTitle(ctx, session, event).catch(error => {
        logger(ctx, 'warn', `dsh-session-folders: title sync failed: ${String(error)}`)
      })
      return
    }
    if (session?.header?.origin === 'subagent') return
    if (event?.type === 'turn/start') {
      activeTurns.add(session.id)
      return
    }
    if (event?.type === 'turn/end') {
      activeTurns.delete(session.id)
      scheduleEmptyCleanup(ctx, session.id)
    }
  })

  ctx.on('workspace/session-archived', async payload => {
    try {
      await handleArchived(ctx, payload?.sessionId)
    } catch (error) {
      logger(ctx, 'warn', `dsh-session-folders: archive handling failed: ${String(error)}`)
    }
  })

  ctx.on('workspace/session-unarchiving', async payload => {
    try {
      await handleUnarchiving(ctx, payload?.sessionId)
    } catch (error) {
      logger(ctx, 'warn', `dsh-session-folders: unarchive handling failed: ${String(error)}`)
    }
  })

  ctx.on('session/disposed', session => {
    // dsh-session-manager emits either the live Session object or, when it
    // has no live entry, a plain `{ id }` fallback. Accept both shapes.
    const sessionId = typeof session === 'string' ? session : (session?.id ?? session?.sessionId)
    if (!sessionId) return
    // Do not delete here: session/disposed is also emitted during clear,
    // reload, and host shutdown. A delayed persistence check below confirms
    // that dsh-session-manager actually completed a permanent deletion.
    scheduleSessionDisposed(ctx, sessionId)
  })
}

// The Cordis loader reads injection from the exported function object.
apply.inject = ['workspaceRegistry', 'workingDirectory', 'sessionTitle']

export const name = 'dsh-session-folders'
export default apply
