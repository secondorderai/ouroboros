import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { type Result, err, ok } from '@src/types'
import { scrubToolEnv } from './env'

export interface WorkerRuntimeSpec {
  taskId: string
  branchName: string
  worktreePath: string
  writeScope: string[]
}

export interface WorkerRuntime {
  taskId: string
  branchName: string
  parentRoot: string
  worktreePath: string
  writeScope: string[]
  release: () => void
}

export interface WorkerDiffResult {
  changedFiles: string[]
  diff: string
}

const activeScopes: Array<{ taskId: string; worktreePath: string; scopes: string[] }> = []

export function createWorkerRuntime(
  spec: WorkerRuntimeSpec,
  basePath: string | undefined,
): Result<WorkerRuntime> {
  const parentRoot = gitOutput(['rev-parse', '--show-toplevel'], basePath ?? process.cwd())
  if (!parentRoot) {
    return err(new Error('Worker runtime requires a git repository.'))
  }

  const worktreePath = resolve(spec.worktreePath)
  if (isInsideDirectory(worktreePath, parentRoot)) {
    return err(new Error('Worker worktree path must be outside the parent worktree.'))
  }

  if (spec.writeScope.length === 0) {
    return err(new Error('Worker runtime requires at least one write scope.'))
  }

  const scopeValidation = validateWriteScopes(spec.writeScope, worktreePath)
  if (!scopeValidation.ok) {
    return scopeValidation
  }

  const overlap = findOverlappingScope(spec.taskId, worktreePath, spec.writeScope)
  if (overlap) {
    return err(
      new Error(`Worker write scope overlaps active task "${overlap.taskId}": ${overlap.scope}`),
    )
  }

  try {
    execFileSync('git', ['worktree', 'add', '-b', spec.branchName, worktreePath, 'HEAD'], {
      cwd: parentRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubbedGitEnv(),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to create worker git worktree: ${message}`))
  }

  const active = { taskId: spec.taskId, worktreePath, scopes: spec.writeScope }
  activeScopes.push(active)

  return ok({
    taskId: spec.taskId,
    branchName: spec.branchName,
    parentRoot,
    worktreePath,
    writeScope: spec.writeScope,
    release: () => {
      const index = activeScopes.indexOf(active)
      if (index >= 0) activeScopes.splice(index, 1)
    },
  })
}

export function collectWorkerDiff(worktreePath: string): WorkerDiffResult {
  const unstaged = gitOutput(['diff', '--name-only', '--diff-filter=ACMRTUXB'], worktreePath)
  const staged = gitOutput(
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB'],
    worktreePath,
  )
  const untracked = gitOutput(['ls-files', '--others', '--exclude-standard'], worktreePath)
  const changedFiles = uniqueLines(unstaged, staged, untracked)
  const diff = gitOutput(['diff', '--no-ext-diff', 'HEAD', '--'], worktreePath)
  const untrackedDiffs = changedFiles
    .filter((path) => untracked.split('\n').includes(path))
    .map((path) => diffUntrackedFile(worktreePath, path))
    .filter(Boolean)

  return {
    changedFiles,
    diff: [diff, ...untrackedDiffs].filter(Boolean).join('\n'),
  }
}

function validateWriteScopes(writeScope: string[], worktreePath: string): Result<void> {
  for (const scope of writeScope) {
    if (!scope.trim()) {
      return err(new Error('Worker write scope entries must not be empty.'))
    }

    const prefix = scopePrefix(scope)
    const absolute = isAbsolute(prefix) ? resolve(prefix) : resolve(worktreePath, prefix)
    if (!isInsideDirectory(absolute, worktreePath)) {
      return err(new Error(`Worker write scope "${scope}" is outside the worker worktree.`))
    }
  }

  return ok(undefined)
}

function findOverlappingScope(
  taskId: string,
  worktreePath: string,
  writeScope: string[],
): { taskId: string; scope: string } | null {
  for (const active of activeScopes) {
    for (const candidate of writeScope) {
      for (const existing of active.scopes) {
        if (scopesOverlap(candidate, worktreePath, existing, active.worktreePath)) {
          return { taskId: active.taskId === taskId ? taskId : active.taskId, scope: existing }
        }
      }
    }
  }

  return null
}

function scopesOverlap(left: string, leftBase: string, right: string, rightBase: string): boolean {
  const leftPath = scopeComparablePath(left, leftBase)
  const rightPath = scopeComparablePath(right, rightBase)
  return isInsideDirectory(leftPath, rightPath) || isInsideDirectory(rightPath, leftPath)
}

function scopeComparablePath(scope: string, base: string): string {
  const prefix = scopePrefix(scope)
  const relativePrefix = isAbsolute(prefix) ? relative(base, resolve(prefix)) : prefix
  return resolve('/', relativePrefix)
}

function scopePrefix(scope: string): string {
  const normalized = normalizePath(scope)
  const globIndex = normalized.search(/[*?[]/)
  const prefix = globIndex >= 0 ? normalized.slice(0, globIndex) : normalized
  const withoutTrailingPartial = prefix.endsWith('/') ? prefix : prefix.replace(/\/[^/]*$/, '')
  return withoutTrailingPartial || '.'
}

function gitOutput(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: scrubbedGitEnv(),
    }).trim()
  } catch {
    return ''
  }
}

// Strip inherited GIT_* env so child `git` invocations always operate on
// `cwd`, not on whatever repo the parent process was bound to (e.g. when
// ouroboros runs inside a git hook, GIT_DIR / GIT_WORK_TREE point at the
// hook's repo and would hijack worktree creation here).
function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env = scrubToolEnv()
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return env
}

function diffUntrackedFile(worktreePath: string, path: string): string {
  const absolutePath = resolve(worktreePath, path)
  if (!existsSync(absolutePath)) return ''

  try {
    return execFileSync('git', ['diff', '--no-index', '--', '/dev/null', absolutePath], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: scrubbedGitEnv(),
    })
  } catch (e) {
    const output = (e as { stdout?: Buffer | string }).stdout
    if (typeof output === 'string') return output
    if (Buffer.isBuffer(output)) return output.toString('utf-8')
    return ''
  }
}

function uniqueLines(...outputs: string[]): string[] {
  return Array.from(
    new Set(
      outputs
        .flatMap((output) => output.split('\n'))
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ).sort()
}

function isInsideDirectory(path: string, directory: string): boolean {
  const rel = normalizePath(relative(directory, path))
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel))
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '')
}
