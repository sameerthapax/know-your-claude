// Human knowledge bar: a health bar above the prompt that Claude's edits
// drain (4 HP per added line, 2 per changed line, 5 per deleted line) and a
// brain test about the project wins back (easy 200, medium 500, hard 1000).
// Health is kept per project, capped at 10,000.
//
// The quiz is written by a separate model call, so this mod holds the right
// answers and Claude never sees them. It runs in this mod's own pane, where
// the arrow keys move between answer cards and Enter picks one; Claude Code's
// question dialog is never used for it, so Claude's own questions are untouched.
//
// Below 6,000 HP the test opens by itself while Claude is working.

const MAX_HP = 10_000
const LOW_HP = 6_000
const COST = { add: 4, change: 2, del: 5 }
const NEW_FILE_COST = 50
const WRONG_ANSWER_COST = 100
// Files that shape the whole system cost double: Terraform and other
// infrastructure, pipelines, the alert contract, and decision records
const ARCHITECTURE = [
  /(^|\/)infra\//,
  /(^|\/)terraform\//,
  /\.(tf|tfvars|bicep)$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)docs\/adr\//,
  /(^|\/)contracts?\//,
  /(^|\/)docs\/architecture\.md$/,
]
const POINTS = { easy: 200, medium: 500, hard: 1000 }
const DOTS = { easy: 1, medium: 2, hard: 3 }
const PLAN = ['easy', 'easy', 'medium', 'medium', 'hard']
const LETTERS = ['A', 'B', 'C', 'D']
const TICK_MS = 100
const CONTEXT_CHARS = 40_000
const CONVERSATION_CHARS = 25_000
const PANE = 'brain-test'
const INLINE_ROWS = 24

// One theme color, in three shades; everything else is the terminal's own text color
const THEME = '#d97757'
const THEME_LIGHT = '#f2b49b'
const THEME_DEEP = '#8f4a35'
const INK = '#1c1c1c'

// Claude Code's own spinner glyphs
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

// Shared by the hooks below
let hp = MAX_HP
let projectKey = 'hp'
let lastDelta = null
let quiz = null // { questions, index, score, right, isLoading, isDone, feedback, startHp, doneAt }
let selected = 0
let resolveAnswer = null
let frame = 0
let timer = null
let isWorking = false
let autoOpenedThisTurn = false
const touched = new Set()

// ---------- health ----------

// Green from 6,000, yellow below 6,000, red below 3,000
function hpColor(value) {
  if (value >= 6000) return '#87af87'
  if (value >= 3000) return '#d7af5f'
  return '#d75f5f'
}

// The change animation: { from, to, ms }, stepped by its own timer
const ANIM_MS = 1500
const ANIM_STEP = 50
let anim = null
let animTimer = null

function startHpAnim($, from, to) {
  // A second change mid-animation starts from what is on screen now
  anim = { from: anim ? shownHp() : from, to, ms: 0 }
  if (animTimer) return
  animTimer = $.clock.every(ANIM_STEP, () => {
    if (anim) anim.ms += ANIM_STEP
    if (!anim || anim.ms >= ANIM_MS) {
      anim = null
      if (animTimer) animTimer.cancel()
      animTimer = null
    }
    $.ui.invalidate('ui.render')
  })
}

// Eased progress 0..1 of the animation's second phase (after a short hold)
function animProgress() {
  if (!anim) return 1
  const t = Math.max(0, (anim.ms - 350) / (ANIM_MS - 350))
  return 1 - Math.pow(1 - Math.min(1, t), 3)
}

// The number on screen: counts from the old value to the new one
function shownHp() {
  if (!anim) return hp
  return Math.round(anim.from + (anim.to - anim.from) * animProgress())
}

// Lines added, changed, and deleted between two texts, by line content
function lineDiff(before, after) {
  const count = (text) => {
    const m = new Map()
    for (const l of text === '' ? [] : text.replace(/\n$/, '').split('\n')) m.set(l, (m.get(l) || 0) + 1)
    return m
  }
  const a = count(before)
  const b = count(after)
  let added = 0
  let removed = 0
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) || 0))
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) || 0))
  const change = Math.min(added, removed)
  return { add: added - change, change, del: removed - change }
}

async function setHp($, value, note) {
  const before = hp
  hp = Math.max(0, Math.min(MAX_HP, Math.round(value)))
  await $.store.set(projectKey, hp)
  if (hp !== before) {
    startHpAnim($, before, hp)
    lastDelta = { value: hp - before, note }
    $.clock.after(15_000, () => {
      lastDelta = null
      $.ui.invalidate('ui.render')
    })
  }
  $.ui.invalidate('ui.render')
}

function isArchitecture(file) {
  return ARCHITECTURE.some((pattern) => pattern.test(String(file || '')))
}

async function drain($, diff, file, isNewFile) {
  const isArch = isArchitecture(file)
  const lines = diff.add * COST.add + diff.change * COST.change + diff.del * COST.del
  const cost = lines * (isArch ? 2 : 1) + (isNewFile ? NEW_FILE_COST : 0)
  if (file) touched.add(file)
  const name = String(file || '').split('/').pop()
  const why = (isNewFile ? 'Claude created ' : 'Claude edited ') + name + (isArch ? ' (architecture ×2)' : '')
  if (cost > 0) await setHp($, hp - cost, why)
  await maybeAutoOpen($)
}

// Files Claude changes through Bash (sed, a heredoc, a script) never pass
// through Edit or Write, so each Bash call is bracketed by two looks at git:
// every file git calls changed or untracked, with its text. A file whose text
// differs between the two looks was changed by the command, and is measured
// against its text before (or HEAD's, if it was clean then). Outside a git
// repository nothing is measured.
const SNAPSHOT_MAX_FILES = 300
const SNAPSHOT_MAX_CHARS = 1_000_000

async function gitTop($) {
  const out = await run($, ['git', '-C', await $.session.root(), 'rev-parse', '--show-toplevel'])
  return out.trim() || null
}

async function readText($, path) {
  try {
    if (!(await $.fs.exists(path))) return ''
    const text = await $.fs.read(path)
    // Binary or huge files are not lines of code
    return text.length > SNAPSHOT_MAX_CHARS || text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

// { path: text } for every changed or untracked file, paths relative to top
async function snapshot($, top) {
  const out = await run($, ['git', '-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = out.split('\0')
  const files = new Map()
  for (let i = 0; i < entries.length && files.size < SNAPSHOT_MAX_FILES; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    // A rename is followed by its old path, which is not a file to read
    if (entry[0] === 'R' || entry[0] === 'C') i++
    const path = entry.slice(3)
    files.set(path, await readText($, top + '/' + path))
  }
  return files
}

async function drainShellChanges($, top, before, after) {
  for (const [path, text] of after) {
    if (text === null) continue
    const wasDirty = before.has(path)
    if (wasDirty && before.get(path) === text) continue
    const old = wasDirty ? before.get(path) : await run($, ['git', '-C', top, 'show', 'HEAD:' + path])
    if (old === null) continue
    await drain($, lineDiff(old, text), top + '/' + path, old === '' && !wasDirty)
  }
}

// Below 6,000 HP, while Claude is working, open the test once per turn
async function maybeAutoOpen($) {
  if (hp >= LOW_HP || !isWorking || quiz || autoOpenedThisTurn) return
  autoOpenedThisTurn = true
  const r = await $.ui.open({ id: PANE, title: 'Brain test', closeOnEscape: true, rows: INLINE_ROWS })
  if (r && r.isPlaced === false) {
    await $.ui.close({ id: PANE })
    $.ui.toast('🧠 Knowledge is low (' + hp.toLocaleString() + ' HP). Type /brain-test to win it back.', { timeoutMs: 8000 })
    return
  }
  sfx($, 'alert')
  runQuiz($).catch(() => {}) // stopped by a reload; nothing to report
}

// ---------- sound ----------

// Under WSL a small Windows PowerShell player (sounds/player.ps1) mixes quiet
// looping music with short effects; this mod sends it numbered commands
// through a file. Claude Code's own player is macOS only, so elsewhere the
// effects use $.audio.play and there is no music.
const SOUND_FILES = ['alert', 'correct', 'done', 'music', 'select', 'start', 'wrong']
let soundDir = null // the player's folder, as this side sees it
let soundStarting = null
let soundSeq = 0
let soundQueue = []

async function startPlayer($) {
  const temp = await $.process.run(['powershell.exe', '-NoProfile', '-Command', '[IO.Path]::GetTempPath()'], { timeoutMs: 8000 })
  if (temp.exitCode !== 0 || !temp.stdout.trim()) return null
  const unix = await $.process.run(['wslpath', '-u', temp.stdout.trim()], { timeoutMs: 3000 })
  if (unix.exitCode !== 0) return null
  const dir = unix.stdout.trim().replace(/\/$/, '') + '/brain-bar'
  const src = $.plugin.root + '/sounds/'
  await $.process.run(['mkdir', '-p', dir], { timeoutMs: 3000 })
  await $.process.run(
    ['cp', ...SOUND_FILES.map((n) => src + n + '.wav'), src + 'player.ps1', dir + '/'],
    { timeoutMs: 10000 },
  )
  await $.process.run(['rm', '-f', dir + '/commands.txt', dir + '/player.log'], { timeoutMs: 3000 })
  await $.fs.write(dir + '/alive.txt', String(Date.now()))
  const win = (await $.process.run(['wslpath', '-w', dir], { timeoutMs: 3000 })).stdout.trim()
  await $.process.run(
    [
      'powershell.exe', '-NoProfile', '-Command',
      "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','" +
        win + "\\player.ps1','-Dir','" + win + "'",
    ],
    { timeoutMs: 10000 },
  )
  // Wait for the player to say it started, so no command is missed
  for (let i = 0; i < 40; i++) {
    if (await $.fs.exists(dir + '/player.log')) return dir
    await $.clock.sleep(100)
  }
  return null
}

// Starts the player once per quiz; resolves to its folder, or null without one
let soundUnavailable = false

async function player($) {
  if (soundDir) return soundDir
  if (soundUnavailable) return null
  if (!soundStarting) {
    soundSeq = 0
    soundQueue = []
    soundStarting = startPlayer($).catch(() => null)
  }
  soundDir = await soundStarting
  soundStarting = null
  // No Windows player here (not WSL): stop trying, use $.audio.play
  if (!soundDir) soundUnavailable = true
  return soundDir
}

async function sendSound($, command) {
  const dir = await player($)
  if (!dir) return false
  soundSeq += 1
  soundQueue = [...soundQueue, soundSeq + ' ' + command].slice(-20)
  try {
    await $.fs.write(dir + '/commands.txt', soundQueue.join('\n') + '\n')
    return true
  } catch {
    return false
  }
}

async function sfx($, name) {
  if (await sendSound($, 'sfx ' + name)) return
  try {
    await $.audio.play({ asset: 'sounds/' + name + '.wav' })
  } catch {
    // No player here; the quiz works without sound
  }
}

async function music($, isOn) {
  await sendSound($, 'music ' + (isOn ? 'start' : 'stop'))
}

// Tells the player the mod is still here; it stops itself without this
function heartbeat($) {
  if (soundDir) $.fs.write(soundDir + '/alive.txt', String(Date.now())).catch(() => {})
}

// Stops the music and lets the player exit after its last effect
async function stopPlayer($) {
  if (!soundDir) return
  await sendSound($, 'quit')
  soundDir = null
}

// ---------- quiz ----------

async function run($, args) {
  try {
    const r = await $.process.run(args, { timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout : ''
  } catch {
    return ''
  }
}

async function readHead($, path, chars) {
  try {
    if (!(await $.fs.exists(path))) return ''
    return (await $.fs.read(path)).slice(0, chars)
  } catch {
    return ''
  }
}

// The newest part of this session's conversation, with the code Claude ran
async function conversation($) {
  let messages = []
  try {
    messages = await $.session.messages()
  } catch {
    return ''
  }
  const lines = []
  for (const m of messages.slice(-120)) {
    if (m.text && m.text.trim()) lines.push(m.role + ': ' + m.text.trim().slice(0, 2000))
    for (const u of m.toolUses || []) lines.push('[' + u.tool + '] ' + JSON.stringify(u.input || {}).slice(0, 2500))
  }
  return lines.join('\n').slice(-CONVERSATION_CHARS)
}

async function gatherContext($) {
  const parts = []
  const add = (title, text) => {
    if (text && text.trim()) parts.push('## ' + title + '\n' + text.trim())
  }
  add('This session so far (newest last)', await conversation($))
  add('Files Claude changed this session', [...touched].join('\n'))
  add('Uncommitted changes', (await run($, ['git', 'diff', 'HEAD'])).slice(0, 12_000))
  add('Recent commits', await run($, ['git', 'log', '--stat', '-8', '--format=--- %s']))
  add('Project files', (await run($, ['git', 'ls-files'])).split('\n').slice(0, 300).join('\n'))
  add('README.md', await readHead($, 'README.md', 6_000))
  add('CLAUDE.md', await readHead($, 'CLAUDE.md', 6_000))
  add('docs/architecture.md', await readHead($, 'docs/architecture.md', 6_000))
  return parts.join('\n\n').slice(0, CONTEXT_CHARS)
}

function parseQuiz(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return null
  const data = JSON.parse(text.slice(start, end + 1))
  const questions = (data.questions || []).filter(
    (q) =>
      POINTS[q.difficulty] &&
      typeof q.question === 'string' &&
      Array.isArray(q.choices) &&
      q.choices.length === 4 &&
      Number.isInteger(q.answer) &&
      q.answer >= 0 &&
      q.answer < 4,
  )
  return questions.length ? questions : null
}

function startTicker($) {
  if (timer) return
  timer = $.clock.every(TICK_MS, () => {
    frame += 1
    if (frame % 20 === 0) heartbeat($)
    $.ui.invalidate('ui.render')
  })
}

function stopTicker() {
  if (timer) timer.cancel()
  timer = null
}

// Opens the quiz pane; called from what the person did, so it shows at any width
async function openPane($) {
  const r = await $.ui.open({ id: PANE, title: 'Brain test', focus: true, closeOnEscape: true, rows: INLINE_ROWS })
  if (r && r.isPlaced === false) $.ui.toast('The brain test pane is waiting: ' + (r.reason || 'widen the terminal'))
}

// Resolves with the answer index the person picks, or null when the pane closes
function waitForAnswer() {
  return new Promise((resolve) => {
    resolveAnswer = resolve
  })
}

function answer(i) {
  if (!resolveAnswer || !quiz || quiz.feedback) return
  const resolve = resolveAnswer
  resolveAnswer = null
  resolve(i)
}

async function startFromButton($) {
  await openPane($)
  runQuiz($).catch(() => {}) // stopped by a reload; nothing to report
}

// Each quiz run gets a number; closing the pane cancels the current one.
// A run that finds its number out of date stops at its next step.
let quizRun = 0
let quizAbort = null

function cancelQuiz($, shouldSay) {
  if (!quiz) return
  quizRun += 1
  if (quizAbort) quizAbort.abort()
  quizAbort = null
  if (resolveAnswer) {
    const resolve = resolveAnswer
    resolveAnswer = null
    resolve(null)
  }
  quiz = null
  stopTicker()
  stopPlayer($).catch(() => {})
  $.ui.invalidate('ui.render')
  if (shouldSay) $.ui.toast('Brain test cancelled')
}

async function runQuiz($, topic) {
  if (quiz) return
  quizRun += 1
  const thisRun = quizRun
  const isCurrent = () => thisRun === quizRun
  quizAbort = new AbortController()
  const signal = quizAbort.signal
  quiz = { questions: [], index: 0, score: 0, right: 0, isLoading: true, isDone: false, feedback: null, startHp: hp, loadAt: frame }
  selected = 0
  startTicker($)
  sfx($, 'start').then(() => music($, true)).catch(() => {})
  $.ui.invalidate('ui.render')
  try {
    const context = await gatherContext($)
    if (!isCurrent()) return
    const r = await $.model.complete({
      model: 'sonnet',
      system:
        'You write short multiple-choice quizzes that check whether a developer understands their own project. ' +
        'Reply with JSON only, no prose and no code fences.',
      prompt:
        'Write ' + PLAN.length + ' questions in this order of difficulty: ' + PLAN.join(', ') + '.\n' +
        (topic
          ? 'Every question must be about this topic: ' + topic + '. Use the session conversation and the code Claude ran in it.\n'
          : '') +
        'Otherwise focus mostly on the architecture: how the parts fit together, what calls what, where data and secrets live, and why. ' +
        'Include at least one question about the changes made this session if there are any.\n' +
        'Easy checks a fact, medium checks how two parts connect, hard checks a design reason or a consequence of a change.\n' +
        'Each question at most 160 characters. Exactly 4 choices, each at most 70 characters, only one correct, wrong ones plausible.\n' +
        'Format: {"questions":[{"difficulty":"easy","question":"...","choices":["...","...","...","..."],"answer":0,"why":"one short sentence"}]}\n\n' +
        context,
      maxTokens: 3000,
      timeoutMs: 120_000,
    }, { signal })
    if (!isCurrent()) return
    const questions = r.isAnswered ? parseQuiz(r.text) : null
    if (!questions) {
      $.ui.toast('Could not write a brain test' + (r.isAnswered ? '' : ' (' + r.reason + ')'))
      await $.ui.close({ id: PANE })
      return
    }
    quiz = { ...quiz, questions, isLoading: false }

    for (let i = 0; i < questions.length; i++) {
      quiz.index = i
      quiz.feedback = null
      selected = 0
      $.ui.invalidate('ui.render')
      const q = questions[i]
      const picked = await waitForAnswer()
      if (picked === null || !isCurrent()) return
      const points = POINTS[q.difficulty]
      const isRight = picked === q.answer
      quiz.feedback = { picked, isRight, at: frame }
      $.ui.invalidate('ui.render')
      sfx($, isRight ? 'correct' : 'wrong')
      if (isRight) {
        quiz.score += points
        quiz.right += 1
        await setHp($, hp + points, 'brain test')
      } else {
        quiz.lost = (quiz.lost || 0) + WRONG_ANSWER_COST
        await setHp($, hp - WRONG_ANSWER_COST, 'wrong answer')
      }
      await $.clock.sleep(isRight ? 2000 : 5000)
      if (!isCurrent()) return
    }
    quiz.isDone = true
    quiz.doneAt = frame
    quiz.feedback = null
    $.ui.invalidate('ui.render')
    sfx($, 'done')
    $.ui.log('brain test done: ' + quiz.right + ' of ' + quiz.questions.length + ' right, +' + quiz.score + ' HP, now ' + hp.toLocaleString() + ' / 10,000')
    await $.clock.sleep(6000)
    if (isCurrent()) await $.ui.close({ id: PANE })
  } finally {
    // A cancelled run was already cleaned up by cancelQuiz
    if (isCurrent()) {
      stopTicker()
      stopPlayer($).catch(() => {})
      quiz = null
      resolveAnswer = null
      quizAbort = null
      $.ui.invalidate('ui.render')
    }
  }
}

// ---------- fitting ----------

// Rows a text takes when wrapped to a width
function rowsOf(text, width) {
  return Math.max(1, Math.ceil([...String(text)].length / Math.max(1, width)))
}

// Text cut to a number of characters, with an ellipsis
function clip(text, n) {
  const chars = [...String(text)]
  return chars.length > n ? chars.slice(0, Math.max(0, n - 1)).join('') + '…' : chars.join('')
}

// ---------- pixel art ----------

const DEFAULT_COLOR = 0x01000000
const hex = (c) => parseInt(c.slice(1), 16)

// Claude Code's mascot: X body, o eyes, l legs (two leg poses)
const CLAWD = [
  '..XXXXXXX..',
  '..XoXXXoX..',
  'XXXXXXXXXXX',
  '..XXXXXXX..',
]
const LEGS = [
  ['..l.l.l.l..', '..l.l.l.l..'],
  ['..l.l.l.l..', '.l.l...l.l.'],
]

const BRAIN = [
  '...XXXXXX...',
  '.XXX.XX.XXX.',
  'XX.XXXXXX.XX',
  'XXXX.XX.XXXX',
  'XX.XXXXXX.XX',
  '.XXX.XX.XXX.',
  '...XXXXXX...',
  '.....XX.....',
]

// The loading picture: Claude sends knowledge across to the brain
function loadingPixels(t, width, height) {
  const px = Array.from({ length: height }, () => Array(width).fill(null))
  const put = (x, y, c) => {
    if (x >= 0 && x < width && y >= 0 && y < height) px[y][x] = c
  }
  const clawdX = Math.floor(width * 0.18) - 5
  const brainX = Math.floor(width * 0.82) - 6
  const bob = Math.floor(t / 4) % 2
  const top = Math.floor((height - 8) / 2)
  const art = [...CLAWD, ...LEGS[Math.floor(t / 3) % 2]]
  art.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === 'X' || ch === 'l') put(clawdX + x, top + 1 + y - bob, THEME)
      if (ch === 'o') put(clawdX + x, top + 1 + y - bob, INK)
    }),
  )
  const glow = Math.floor(t / 5) % 2 === 0 ? THEME_LIGHT : THEME
  BRAIN.forEach((row, y) => [...row].forEach((ch, x) => ch === 'X' && put(brainX + x, top + y, glow)))
  // Sparks travel from Claude to the brain
  const from = clawdX + 13
  const to = brainX - 2
  const span = Math.max(1, to - from)
  for (let k = 0; k < 4; k++) {
    const x = from + ((t * 1 + k * Math.ceil(span / 4)) % span)
    const y = top + 3 + Math.round(Math.sin((x - from) / 3) * 1.2)
    put(x, y, k % 2 ? THEME : THEME_LIGHT)
  }
  return px
}

// Pixels to a Raster: two pixel rows per cell, drawn with half blocks
function toCells(px) {
  const nums = []
  for (let y = 0; y < px.length; y += 2) {
    for (let x = 0; x < px[y].length; x++) {
      const top = px[y][x]
      const bottom = y + 1 < px.length ? px[y + 1][x] : null
      if (top && bottom) nums.push('▀'.codePointAt(0), hex(top), hex(bottom))
      else if (top) nums.push('▀'.codePointAt(0), hex(top), DEFAULT_COLOR)
      else if (bottom) nums.push('▄'.codePointAt(0), hex(bottom), DEFAULT_COLOR)
      else nums.push(32, DEFAULT_COLOR, DEFAULT_COLOR)
    }
  }
  return new Uint8Array(Uint32Array.from(nums).buffer).toBase64()
}

// ---------- hooks ----------

export function register(on) {
  on('session.start', async ($, e, next) => {
    projectKey = 'hp:' + (await $.session.root())
    const saved = await $.store.get(projectKey)
    hp = typeof saved === 'number' ? saved : MAX_HP
    try {
      await $.command.register({
        name: 'brain-test',
        description: 'Test your knowledge of this project to win back HP',
        argumentHint: '[topic]',
        immediate: true,
      })
    } catch {
      // The name is taken; the button still works
    }
    return next(e)
  })

  // Know when Claude is working, for the low-health auto-open
  on('turn.start', async ($, e, next) => {
    isWorking = true
    autoOpenedThisTurn = false
    await maybeAutoOpen($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isWorking = false
    return next(e)
  })

  // Claude's file edits drain health once they succeed
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const r = await next(e)
    if (r && !r.deny && !r.isError) await drain($, lineDiff(e.old_string || '', e.new_string || ''), e.file_path)
    return r
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    let before = ''
    let isNewFile = false
    try {
      if (await $.fs.exists(e.file_path)) before = await $.fs.read(e.file_path)
      else isNewFile = true
    } catch {
      before = ''
    }
    const r = await next(e)
    if (r && !r.deny && !r.isError) await drain($, lineDiff(before, e.content || ''), e.file_path, isNewFile)
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const top = await gitTop($)
    const before = top ? await snapshot($, top) : null
    const r = await next(e)
    // A failing command can still have written files, so isError is not checked
    if (top && r && !r.deny) await drainShellChanges($, top, before, await snapshot($, top))
    return r
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const r = await next(e)
    if (r && !r.deny && !r.isError) {
      const lines = (e.new_source || '').split('\n').length
      const diff =
        e.edit_mode === 'insert' ? { add: lines, change: 0, del: 0 }
        : e.edit_mode === 'delete' ? { add: 0, change: 0, del: 1 }
        : { add: 0, change: lines, del: 0 }
      await drain($, diff, e.notebook_path)
    }
    return r
  })

  on('command.run', { command: 'brain-test' }, async ($, e) => {
    if (quiz) return {}
    await openPane($)
    runQuiz($, (e.args || '').trim()).catch(() => {}) // stopped by a reload
    return {}
  })

  // The bar, always above the prompt; other mods' band drawing stays under it
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = 40
    const cells = (v) => Math.round((Math.max(0, v) / MAX_HP) * width)
    const color = hpColor(hp)
    const shown = shownHp()
    const isHit = anim && anim.to < anim.from
    const isHeal = anim && anim.to > anim.from
    const blink = anim ? Math.floor(anim.ms / 150) % 2 === 0 : false

    // Bar: the new health, then the piece that changed, then empty
    let solid = cells(hp)
    let ghost = 0
    let ghostColor = color
    if (isHit) {
      // The lost piece blinks red, then drains away; at least one cell shows
      const edge = anim.from + (anim.to - anim.from) * animProgress()
      ghost = Math.max(anim.ms < ANIM_MS - 100 ? 1 : 0, cells(edge) - solid)
      ghostColor = blink ? '#ff5f5f' : '#870000'
    } else if (isHeal) {
      // The gained piece glows in, growing from the old edge
      solid = cells(anim.from + (anim.to - anim.from) * animProgress())
      ghost = Math.max(0, cells(hp) - solid)
      ghostColor = blink ? '#d7ffd7' : '#87af87'
    }
    ghost = Math.min(ghost, width - solid)

    const children = [
      Text({ children: [isHit && anim.ms < 450 ? '💥 ' : '🧠 '] }),
      Text({ color, children: ['█'.repeat(solid)] }),
      Text({ color: ghostColor, children: [(isHit ? '▓' : '█').repeat(ghost)] }),
      Text({ dimColor: true, children: ['░'.repeat(width - solid - ghost)] }),
      Text({
        bold: true,
        ...(isHit ? { color: '#ff8787' } : isHeal ? { color: '#afffaf' } : {}),
        children: ['  ' + shown.toLocaleString() + ' / 10,000 HP'],
      }),
    ]
    if (lastDelta) {
      children.push(
        Text({
          color: lastDelta.value > 0 ? '#87af87' : '#d78787',
          children: ['  ' + (lastDelta.value > 0 ? '+' : '') + lastDelta.value + ' ' + lastDelta.note],
        }),
      )
    }
    children.push(Text({ children: ['   '] }))
    if (quiz && quiz.isLoading) {
      children.push(Text({ dimColor: true, children: ['writing your brain test…'] }))
    } else if (quiz && !quiz.isDone) {
      children.push(Text({ dimColor: true, children: ['brain test ' + (quiz.index + 1) + '/' + quiz.questions.length] }))
    } else if (!quiz) {
      children.push(Button({ key: 'brain-test', label: 'Test my brain', onPress: () => startFromButton($) }))
    }
    const bar = Box({ flexDirection: 'row', children })
    const theirs = await next(e)
    return Box({ flexDirection: 'column', children: theirs ? [bar, theirs] : [bar] })
  })

  // Arrow keys move the focus between answer buttons; follow it to light the card
  on('ui.focus', async ($, e, next) => {
    if (e.requestId === PANE && typeof e.element === 'string' && e.element.startsWith('ans-')) {
      const moved = Number(e.element.slice(4))
      if (moved !== selected && e.origin && e.origin.kind === 'person') sfx($, 'select').catch(() => {})
      selected = moved
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Esc or ctrl+x x closes the pane: stop the test
  // Closing the pane cancels the test at any stage, loading included
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      stopPlayer($).catch(() => {})
      // Only say so when a test was really cut short, not when it closed itself at the end
      cancelQuiz($, Boolean(quiz && !quiz.isDone))
    }
    return next(e)
  })

  // Arrows scroll a pane taller than its window instead of moving the focus.
  // While a question waits, turn those arrow presses into moving the selection.
  on('ui.scroll', async ($, e, next) => {
    const isArrow = e.origin && e.origin.kind === 'person' && !e.pointer && Math.abs(e.by) === 1
    const isAsking = quiz && !quiz.isLoading && !quiz.isDone && !quiz.feedback
    if (e.requestId !== PANE || !isArrow || !isAsking) return next(e)
    const moved = Math.max(0, Math.min(3, selected + Math.sign(e.by)))
    if (moved !== selected) sfx($, 'select').catch(() => {})
    selected = moved
    $.ui.invalidate('ui.render')
    $.ui.focus({ requestId: PANE, key: 'ans-' + selected }).catch(() => {})
    $.ui.scroll({ in: PANE, to: { key: 'card-' + selected } }).catch(() => {})
    return { deny: 'the arrow moved the selection' }
  })

  // The quiz pane: retro, and sized to the pane it is given
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Raster } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const viewRows = e.viewport && e.viewport.rows ? e.viewport.rows : 40
    const height =
      e.props.placement === 'dock' ? Math.max(10, e.props.scroll.bodyRows) : Math.max(12, Math.min(INLINE_ROWS, viewRows - 8))
    const inner = width - 4 // inside the double frame and its padding
    const isTerminal = e.surface === 'terminal'
    const spin = SPINNER[frame % SPINNER.length]
    const cursor = Math.floor(frame / 5) % 2 === 0 ? '█' : ' '
    const blank = () => Text({ children: [' '] })
    const frameBox = (children, extra = {}) =>
      Box({ flexDirection: 'column', width, height, borderStyle: 'double', borderColor: THEME, paddingX: 1, ...extra, children })
    const title = (right) =>
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [
          Text({ bold: true, color: THEME, children: [inner < 40 ? '▓▒░ BRAIN' : '▓▒░ BRAIN TEST ░▒▓'] }),
          Text({ color: THEME, children: [right] }),
        ],
      })
    const rule = Text({ color: THEME_DEEP, children: ['═'.repeat(inner)] })

    // ----- loading: Claude passing knowledge to the brain, filling the pane -----
    if (!quiz || quiz.isLoading) {
      const t = quiz ? frame - quiz.loadAt : frame
      const phases = ['READING THIS SESSION', 'MAPPING THE ARCHITECTURE', 'PICKING WHAT MATTERS', 'WRITING 5 QUESTIONS']
      const phase = phases[Math.floor(t / 25) % phases.length]
      const barWidth = Math.min(inner - 2, 30)
      const filled = Math.min(barWidth, Math.floor(t / 3) % (barWidth + 1))
      const meter = '▓'.repeat(filled) + '░'.repeat(barWidth - filled)
      const roomForArt = height - 9 >= 7 && inner >= 34
      const artWidth = Math.min(inner, 64)
      const art =
        isTerminal && roomForArt
          ? Raster({ key: 'loading', columns: artWidth, rows: 7, cells: toCells(loadingPixels(t, artWidth, 14)) })
          : Text({ color: THEME, children: [spin + ' ' + '·•'.repeat(1 + (t % 3)) + ' 🧠'] })
      return frameBox(
        [
          title(spin),
          rule,
          Box({
            flexDirection: 'column',
            flexGrow: 1,
            justifyContent: 'center',
            alignItems: 'center',
            children: [
              art,
              blank(),
              Text({ bold: true, color: THEME, children: ['LOADING' + '.'.repeat((Math.floor(t / 4) % 3) + 1)] }),
              Text({ dimColor: true, children: [phase] }),
              blank(),
              Text({ color: THEME, children: [meter] }),
            ],
          }),
        ],
        { key: 'loading-frame' },
      )
    }

    // ----- done: arcade score -----
    if (quiz.isDone) {
      const t = frame - quiz.doneAt
      const won = Math.round(quiz.score * Math.min(1, t / 12))
      const score = String(won).padStart(6, '0')
      const blink = Math.floor(t / 4) % 2 === 0
      const jump = Math.floor(t / 3) % 2
      const px = Array.from({ length: 10 }, () => Array(11).fill(null))
      ;[...CLAWD, ...LEGS[jump]].forEach((row, y) =>
        [...row].forEach((ch, x) => {
          const yy = y + 2 - jump * 2
          if (ch === 'X' || ch === 'l') px[yy][x] = THEME
          if (ch === 'o') px[yy][x] = INK
        }),
      )
      return frameBox([
        title('★'),
        rule,
        Box({
          flexDirection: 'column',
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
          children: [
            ...(isTerminal && height >= 16 ? [Raster({ key: 'done', columns: 11, rows: 5, cells: toCells(px) }), blank()] : []),
            Text({ bold: true, color: THEME, children: [blink ? '★  QUIZ COMPLETE  ★' : '☆  QUIZ COMPLETE  ☆'] }),
            blank(),
            Text({ bold: true, children: ['SCORE  ' + score] }),
            Text({ children: [quiz.right + ' / ' + quiz.questions.length + ' CORRECT'] }),
            ...(quiz.lost ? [Text({ dimColor: true, children: ['−' + quiz.lost + ' HP for wrong answers'] })] : []),
            Text({ dimColor: true, children: ['HP ' + quiz.startHp.toLocaleString() + ' → ' + hp.toLocaleString()] }),
          ],
        }),
      ])
    }

    // ----- a question -----
    const q = quiz.questions[quiz.index]
    const fb = quiz.feedback
    const t = fb ? frame - fb.at : 0
    const progress = quiz.questions.map((_, i) => (i <= quiz.index ? '▰' : '▱')).join('')
    const dots = '●'.repeat(DOTS[q.difficulty]) + '○'.repeat(3 - DOTS[q.difficulty])
    const right = inner < 44 ? dots : dots + '  +' + POINTS[q.difficulty] + '  ' + progress

    // Fit to the pane: wrapped answers if they fit, one line each if not
    const optWidth = inner - 7 // "▶ [A] "
    const fixed = 2 /* frame */ + 2 /* title, rule */ + 1 /* Q n/5 */ + 1 + 1 + 1 /* blanks */ + (fb ? 3 : 1) /* footer */
    const questionRows = rowsOf('> ' + q.question + ' ', inner)
    const wrappedRows = q.choices.reduce((n, c) => n + rowsOf(c, optWidth), 0)
    const isRoomy = fixed + questionRows + wrappedRows <= height
    const isTight = fixed + questionRows + 4 > height
    const choiceText = (c) => (isRoomy ? c : clip(c, optWidth))

    const rows = q.choices.map((choice, i) => {
      const isSel = i === selected && !fb
      const isAnswer = i === q.answer
      const isPicked = fb && i === fb.picked
      let fill = {}
      let text = {}
      let marker = ' '
      let shift = 0

      if (isSel) {
        // Selected: an inverse bar with a blinking pointer
        fill = { backgroundColor: THEME }
        text = { color: INK, bold: true }
        marker = Math.floor(frame / 5) % 2 === 0 ? '▶' : '▷'
      } else if (fb && fb.isRight && isPicked) {
        // Right: the bar flashes, then stays lit
        const flash = t < 8 && Math.floor(t / 2) % 2 === 0
        fill = { backgroundColor: flash ? THEME_LIGHT : THEME }
        text = { color: INK, bold: true }
        marker = '✓'
      } else if (fb && !fb.isRight && isPicked) {
        // Wrong: the row shakes and is struck through
        shift = t < 8 ? [0, 2, 0, 2, 1, 0, 1, 0][t] : 0
        text = { strikethrough: true, dimColor: true }
        marker = '✗'
      } else if (fb && !fb.isRight && isAnswer && t >= 6) {
        // Then the right answer lights up and pulses
        fill = { backgroundColor: Math.floor(t / 3) % 2 === 0 ? THEME : THEME_LIGHT }
        text = { color: INK, bold: true }
        marker = '✓'
      } else if (fb) {
        text = { dimColor: true }
      }

      return Box({
        key: 'card-' + i,
        flexDirection: 'row',
        marginLeft: shift,
        ...fill,
        children: [
          Text({ color: fill.backgroundColor ? INK : THEME, bold: true, children: [marker + ' '] }),
          fb
            ? Text({ ...text, children: ['[' + LETTERS[i] + '] '] })
            : Button({
                key: 'ans-' + i,
                label: '[' + LETTERS[i] + ']',
                plain: true,
                ...(i === selected ? { autoFocus: true } : {}),
                onPress: () => answer(i),
              }),
          Text({ ...text, wrap: isRoomy ? 'wrap' : 'truncate-end', children: [' ' + choiceText(choice)] }),
        ],
      })
    })

    let footer
    if (!fb) {
      footer = Text({ dimColor: true, children: [inner < 44 ? '↑↓ ⏎ esc' : '↑↓ SELECT   ⏎ CONFIRM   ESC QUIT'] })
    } else if (fb.isRight) {
      const won = Math.round(POINTS[q.difficulty] * Math.min(1, t / 8))
      const stars = Math.floor(t / 2) % 2 === 0 ? '★ ☆ ★' : '☆ ★ ☆'
      footer = Box({
        flexDirection: 'column',
        alignItems: 'center',
        children: [
          Text({ color: THEME, children: [stars] }),
          Text({ bold: true, color: THEME, children: ['CORRECT  +' + won + ' HP'] }),
          blank(),
        ],
      })
    } else {
      const why = 'ANSWER: ' + LETTERS[q.answer] + '. ' + (q.why || '')
      const typed = t < 6 ? '' : why.slice(0, (t - 6) * 4)
      footer = Box({
        flexDirection: 'column',
        children: [
          Text({ bold: true, color: THEME_DEEP, children: ['✗ WRONG  −' + WRONG_ANSWER_COST + ' HP'] }),
          Text({ wrap: isTight ? 'truncate-end' : 'wrap', children: [typed + (typed.length < why.length && t >= 6 ? '█' : '')] }),
        ],
      })
    }

    return frameBox([
      title(right),
      rule,
      Text({ color: THEME, children: ['Q' + (quiz.index + 1) + '/' + quiz.questions.length + '  ' + q.difficulty.toUpperCase()] }),
      Text({
        bold: true,
        wrap: isTight ? 'truncate-end' : 'wrap',
        children: [
          Text({ color: THEME, children: ['> '] }),
          isTight ? clip(q.question, inner - 4) : q.question,
          Text({ color: THEME, children: [' ' + (fb ? '' : cursor)] }),
        ],
      }),
      ...(isTight ? [] : [blank()]),
      ...rows,
      ...(isTight ? [] : [blank()]),
      footer,
    ])
  })
}
