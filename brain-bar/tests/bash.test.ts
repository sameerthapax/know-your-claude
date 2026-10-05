import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'brain-bar',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

// A git repository at /repo whose status, file texts and HEAD change when Bash runs
function world(on: any, hp: number, repo: { status: [string, string]; files: [Record<string, string>, Record<string, string>]; head: Record<string, string> } | null) {
  let phase = 0
  mock.store(on, { 'hp:/repo': hp })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('audio.play', () => ({ value: undefined }))
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    const fail = { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
    if (argv[0] !== 'git' || !repo) return fail
    if (argv.includes('rev-parse')) return ok('/repo\n')
    if (argv.includes('status')) return ok(repo.status[phase])
    if (argv.includes('show')) {
      const path = argv[argv.length - 1].slice('HEAD:'.length)
      return path in repo.head ? ok(repo.head[path]) : fail
    }
    return fail
  })
  on('fs.exists', ($: any, e: any) => ({ value: !!repo && e.path.slice('/repo/'.length) in repo.files[phase] }))
  on('fs.read', ($: any, e: any) => ({ value: repo?.files[phase][e.path.slice('/repo/'.length)] ?? '' }))
  on('tool.call', () => {
    phase = 1
    return { result: 'ok' }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
}

const shownHp = async ($: any) => {
  const band = await $.ui.mount(BAND)
  return (await band.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')
}

test('a Bash command that rewrites a clean file costs its lines against HEAD', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 9000, {
    status: ['', ' M test.txt\0'],
    files: [{}, { 'test.txt': 'a 1\nb 2\nc 3\n' }],
    head: { 'test.txt': 'a\nb\nc\n' },
  })
  await $.session.start({ cwd: '/repo' })
  // 3 changed lines: 3 x 2 = 6
  await $.tool.call({ tool: 'Bash', command: "python3 -c '...'" })
  await clock.advance(2000)
  expect(await shownHp($)).toContain('8,994 / 10,000 HP')
})

test('a Bash command that creates a file costs its lines plus 50', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 9000, {
    status: ['', '?? new.txt\0'],
    files: [{}, { 'new.txt': 'x\ny\n' }],
    head: {},
  })
  await $.session.start({ cwd: '/repo' })
  // 2 added lines: 2 x 4 = 8, plus 50 for a new file
  await $.tool.call({ tool: 'Bash', command: 'printf "x\\ny\\n" > new.txt' })
  await clock.advance(2000)
  expect(await shownHp($)).toContain('8,942 / 10,000 HP')
})

test('a file already changed before the command costs only what the command added', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 9000, {
    status: [' M app.ts\0', ' M app.ts\0'],
    files: [{ 'app.ts': 'a\nb\n' }, { 'app.ts': 'a\nb\nc\n' }],
    head: { 'app.ts': '' },
  })
  await $.session.start({ cwd: '/repo' })
  // 1 added line: 4
  await $.tool.call({ tool: 'Bash', command: 'echo c >> app.ts' })
  await clock.advance(2000)
  expect(await shownHp($)).toContain('8,996 / 10,000 HP')
})

test('a Bash command that changes nothing costs nothing', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 9000, {
    status: [' M app.ts\0', ' M app.ts\0'],
    files: [{ 'app.ts': 'a\n' }, { 'app.ts': 'a\n' }],
    head: { 'app.ts': '' },
  })
  await $.session.start({ cwd: '/repo' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(2000)
  expect(await shownHp($)).toContain('9,000 / 10,000 HP')
})

test('outside a git repository Bash costs nothing', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 9000, null)
  await $.session.start({ cwd: '/repo' })
  await $.tool.call({ tool: 'Bash', command: 'echo hi > x.txt' })
  await clock.advance(2000)
  expect(await shownHp($)).toContain('9,000 / 10,000 HP')
})
